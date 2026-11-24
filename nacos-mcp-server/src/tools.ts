import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {
    Api,
    type ConfigDetail,
    DEFAULT_GROUP,
    type Instance,
    md5,
    metadataText,
    newNamespaceId,
    type Service,
    until
} from './api.js';
import type {Config} from './config.js';
import {decode, Failure, type FormValue, type RequestOptions} from './nacos.js';

export const INSTRUCTIONS = `Access to a Nacos server: configuration center and service registry.
1. Namespaces are given by id or name; "public" or nothing means the public namespace. list_namespaces shows them.
2. Services and instances: list_services, describe_service (settings, clusters and every instance, disabled ones included), register_instance, update_instance, deregister_instance.
   To take an instance out of rotation set enabled to false; to change a weight or metadata, update_instance keeps the fields you do not mention.
3. Configurations: list_configs, get_config, publish_config, delete_config, config_history. To change a configuration, read it with get_config and publish with its md5 as expected_md5, so that a concurrent change is not overwritten.
4. read_request runs any GET request against the Nacos API and request any other request, for everything the other tools do not cover (listeners, subscribers, metrics, switches, users and roles, import and export). Paths start with v1/ or v2/.
5. Tools that delete, and requests that delete or change who may log in, are refused until \`confirm\` is true. Set it only after the user has agreed to that exact action.`;

/** Largest result, as JSON, that is handed back; anything bigger is refused with a hint. */
const MAX_RESULT_CHARS = 100_000;
/** How long a change is given to become visible before the result says so. */
const SETTLE_MS = 5_000;
const NAMESPACE_ID = /^[0-9A-Za-z_-]{1,64}$/;

function text(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Cuts long text (configuration content, historical versions) and says how much is missing. */
function clip(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, maxChars)}…[${content.length - maxChars} more chars]` : content;
}

export function describeError(error: unknown): string {
  if (error instanceof Failure || error instanceof Error) return error.message;
  return String(error);
}

/** A path as typed by a model, with or without the context path and the leading slash: "/nacos/v1/ns/…" or "v1/ns/…". */
function normalizePath(path: string): string {
  const trimmed = path
    .trim()
    .replace(/^\/nacos(?=\/)/, '')
    .replace(/^\/+/, '');
  if (!/^v\d+\//.test(trimmed)) {
    throw new Error(`"${path}" is not an API path: paths start with v1/ or v2/, for example "v1/ns/operator/metrics".`);
  }
  return trimmed.split('?')[0] ?? trimmed;
}

function queryOf(path: string, query: Record<string, unknown> | undefined): Record<string, FormValue> {
  const result: Record<string, FormValue> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    // An array or object cannot be one parameter, and guessing a notation for it would only mislead Nacos.
    if (typeof value === 'object')
      throw new Error(
        `Query parameter "${key}" must be a string, a number or a boolean, not ${Array.isArray(value) ? 'an array' : 'an object'}.`,
      );
    result[key] = String(value);
  }
  // Whatever follows "?" in the path counts too, so a path may be pasted as a whole.
  const search = path.split('?')[1];
  if (search) {
    for (const [key, value] of new URLSearchParams(search)) result[key] = value;
  }
  return result;
}

/** Requests that need the user's explicit agreement, with the reason. */
const CONFIRM = [
  { pattern: /core\/cluster\/server\/leave/, reason: 'tells this Nacos node to leave the cluster' },
  { pattern: /v\d\/auth\/(users|roles|permissions)/, reason: 'changes who may log in to Nacos and what they may do' },
  { pattern: /(import|clone)=true/, reason: 'copies configurations in bulk' },
];

/** Looks at the path and at the query parameters alike: "?clone=true" may be written into either. */
function dangerOf(method: string, path: string, query: Record<string, unknown> | undefined): string | undefined {
  if (method === 'DELETE') return 'deletes something';
  const parameters = new URLSearchParams(Object.entries(query ?? {}).map(([key, value]) => [key, String(value)])).toString();
  return CONFIRM.find((rule) => rule.pattern.test(`${path}&${parameters}`))?.reason;
}

export interface ToolContext {
  config: Config;
  api: Api;
}

export function registerTools(server: McpServer, { config, api }: ToolContext): void {
  // A tool callback must not throw into the SDK: every failure becomes a message the model can act on.
  /** A tool callback must not throw into the SDK: every failure becomes a message the model can act on. */
  const guard = async (body: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await body();
    } catch (error) {
      return failure(describeError(error));
    }
  };

  /** Refuses results that would flood the model's context. */
  const present = (payload: unknown): CallToolResult => {
    const size = JSON.stringify(payload).length;
    if (size > MAX_RESULT_CHARS) {
      return failure(
        `The result is too large to return (${Math.round(size / 1024)} KB). Ask for a narrower page, a filter, or use read_request with a more specific query.`,
      );
    }
    return text(payload);
  };

  const confirmParam = z.boolean().default(false).describe('Required for this action. Set only after the user approved this exact action.');
  const namespaceParam = z.string().min(1).optional().describe('Namespace id or name; omitted or "public" means the public namespace.');
  const groupParam = z.string().min(1).optional().describe(`Group, "${DEFAULT_GROUP}" by default.`);
  const metadataParam = z.record(z.string(), z.string()).optional().describe('Metadata as an object of strings.');
  const pageParam = z.number().int().min(1).default(1);
  const pageSizeParam = z.number().int().min(1).max(200).default(50);

  const servicePath = async (group: string | undefined, namespace: string | undefined) => ({
    namespace: await api.namespaceId(namespace),
    group: group ?? DEFAULT_GROUP,
  });

  const describeService = async (service: string, group: string | undefined, namespace: string | undefined): Promise<CallToolResult> => {
    const path = await servicePath(group, namespace);
    const detail = await api.service(service, path.group, path.namespace);
    if (!detail) {
      return failure(`Service "${service}" in group "${path.group}" of namespace "${path.namespace || 'public'}" does not exist.`);
    }
    const instances = await api.instances(service, path.group, path.namespace);
    const subscribers = await api.json('GET', 'v1/ns/service/subscribers', {
      query: { serviceName: service, namespaceId: path.namespace, pageNo: 1, pageSize: 1 },
    });
    return present({
      namespace: path.namespace || 'public',
      service: detail.name,
      group: detail.group,
      ephemeral: detail.ephemeral,
      protect_threshold: detail.protectThreshold,
      selector: detail.selector,
      metadata: detail.metadata,
      clusters: detail.clusters.map((cluster) => ({
        name: cluster.name,
        health_check: cluster.healthCheck,
        check_port: cluster.checkPort,
        use_instance_port_for_check: cluster.useInstancePortForCheck,
        metadata: cluster.metadata,
      })),
      instances,
      subscriber_count: Number(subscribers.count ?? 0),
    });
  };

  const showService = (service: Service, namespace: string) => ({
    namespace: namespace || 'public',
    service: service.name,
    group: service.group,
    ephemeral: service.ephemeral,
    protect_threshold: service.protectThreshold,
    metadata: service.metadata,
  });

  const configPath = async (group: string | undefined, namespace: string | undefined) => ({
    namespace: await api.namespaceId(namespace),
    group: group ?? DEFAULT_GROUP,
  });

  const showConfig = (config: ConfigDetail) => ({
    data_id: config.dataId,
    group: config.group,
    type: config.type,
    md5: config.md5,
    created_at: config.createdAt,
    modified_at: config.modifiedAt,
    ...(config.createdBy ? { created_by: config.createdBy } : {}),
    ...(config.createdFrom ? { created_from: config.createdFrom } : {}),
    ...(config.description ? { description: config.description } : {}),
  });

  const configFailure = (dataId: string, group: string, namespace: string) =>
    failure(`Configuration "${dataId}" in group "${group}" of namespace "${namespace || 'public'}" does not exist.`);

  const requestBody = z
    .unknown()
    .optional()
    .describe(
      'Request body: an object for form, JSON or multipart bodies, a string for text. For multipart give { "file": { "base64": "…", "filename": "x.zip" }, …fields }.',
    );
  const showReply = async (method: string, path: string, options: RequestOptions) => {
    const reply = await api.call(method, normalizePath(path), options);
    return present({ status: reply.status, body: decode(reply) });
  };

  // ---- namespaces ----

  server.registerTool(
    'list_namespaces',
    {
      title: 'List namespaces',
      description: 'List the namespaces of the Nacos server with their ids, names, descriptions and how many configurations each holds.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      guard(async () => {
        const namespaces = await api.namespaces();
        return present({
          count: namespaces.length,
          namespaces: namespaces.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            config_count: item.configCount,
          })),
        });
      }),
  );

  if (!config.readonly) {
    server.registerTool(
      'save_namespace',
      {
        title: 'Create or update a namespace',
        description:
          'Create a namespace, or update the name and description of an existing one. ' +
          'With an `id` that exists the namespace is updated; without an `id` a namespace with that name is updated when there is exactly one, and otherwise created with a generated id. The id cannot be changed later.',
        inputSchema: {
          name: z.string().min(1).describe('Name shown in the console.'),
          id: z
            .string()
            .regex(NAMESPACE_ID)
            .optional()
            .describe('Id of the namespace. Letters, digits, "-" and "_" only. Omit to get a generated id.'),
          description: z.string().optional().describe('Description shown in the console.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      ({ id, name, description }) =>
        guard(async () => {
          const all = await api.namespaces();
          const existing = id ? all.find((item) => item.id === id) : all.find((item) => item.name === name);
          if (existing) {
            await api.updateNamespace(existing.id, name, description ?? existing.description);
            return text({ namespace: { id: existing.id, name, description: description ?? existing.description }, created: false });
          }
          const newId = id ?? newNamespaceId();
          await api.createNamespace(newId, name, description ?? '');
          return text({ namespace: { id: newId, name, description: description ?? '' }, created: true });
        }),
    );

    server.registerTool(
      'delete_namespace',
      {
        title: 'Delete an empty namespace',
        description:
          'Delete a namespace. It must be empty: a namespace that still holds configurations or services is refused, because Nacos would delete the namespace yet keep the configurations stored, where nothing can see them. The public namespace cannot be deleted.',
        inputSchema: { namespace: z.string().min(1).describe('Id or name of the namespace to delete.'), confirm: confirmParam },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ namespace, confirm }) =>
        guard(async () => {
          if (!namespace || namespace === 'public') return failure('The public namespace cannot be deleted.');
          const id = await api.namespaceId(namespace);
          const info = (await api.namespaces()).find((item) => item.id === id);
          const services = await api.services(id, undefined, undefined, 1, 1);
          if ((info?.configCount ?? 0) > 0 || services.total > 0) {
            return failure(
              `Namespace "${info?.name ?? id}" is not empty: ${info?.configCount ?? 0} configurations and ${services.total} services. ` +
                'Deleting it would leave the configurations stored but invisible. Delete them first (list_configs and delete_config, or deregister the instances and delete_service).',
            );
          }
          if (!confirm) {
            return failure(
              `Refused: deleting namespace "${info?.name ?? id}" cannot be undone. Call again with confirm: true once the user agrees.`,
            );
          }
          await api.deleteNamespace(id);
          return text({ deleted: true, namespace: { id, name: info?.name ?? id } });
        }),
    );
  }

  // ---- services ----

  server.registerTool(
    'list_services',
    {
      title: 'List services',
      description:
        'List the services of a namespace across all groups, with cluster and instance counts. Filter by group and by a keyword in the service name. ' +
        'The list is refreshed about once a second, so a service created a moment ago may take a second to appear.',
      inputSchema: {
        namespace: namespaceParam,
        group: groupParam,
        keyword: z.string().min(1).optional().describe('Only services whose name contains this text.'),
        page: pageParam,
        page_size: pageSizeParam,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ namespace, group, keyword, page, page_size }) =>
      guard(async () => {
        const id = await api.namespaceId(namespace);
        const found = await api.services(id, group, keyword, page, page_size);
        return present({
          namespace: id || 'public',
          page,
          total: found.total,
          services: found.services.map((item) => ({
            name: item.name,
            group: item.group,
            clusters: item.clusters,
            instances: item.instances,
            healthy_instances: item.healthyInstances,
            protection_triggered: item.protectionTriggered,
          })),
        });
      }),
  );

  server.registerTool(
    'describe_service',
    {
      title: 'Describe a service',
      description:
        'Show a service with its settings, its clusters and all of its instances with ip, port, cluster, weight, health, whether they are enabled, and metadata. ' +
        'Disabled instances are included, although Nacos leaves them out of what it hands to applications. Also tells how many clients subscribe to the service.',
      inputSchema: { service: z.string().min(1), group: groupParam, namespace: namespaceParam },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ service, group, namespace }) => guard(() => describeService(service, group, namespace)),
  );

  if (!config.readonly) {
    server.registerTool(
      'save_service',
      {
        title: 'Create or update a service',
        description:
          'Create a service, or change the settings of an existing one (protection threshold, metadata, selector). Fields that are left out keep their current values. ' +
          '`ephemeral` can only be set when creating: applications register ephemeral services, while false creates a persistent one; instances must match the service. ' +
          'A service without instances is removed by Nacos after about a minute.',
        inputSchema: {
          service: z.string().min(1),
          group: groupParam,
          namespace: namespaceParam,
          protect_threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              'Protection threshold, 0 to 1: when more than this share of instances is unhealthy, all of them are returned to callers.',
            ),
          metadata: metadataParam,
          selector: z
            .object({ type: z.enum(['none', 'label']), expression: z.string().optional() })
            .optional()
            .describe(
              'Selector. A label selector takes an expression of the form "CONSUMER.label.zone=PROVIDER.label.zone", several joined with &.',
            ),
          ephemeral: z
            .boolean()
            .optional()
            .describe('Only for a new service: true (as applications register it) or false (persistent, the default).'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      ({ service, group, namespace, protect_threshold, metadata, selector, ephemeral }) =>
        guard(async () => {
          const path = await servicePath(group, namespace);
          const existing = await api.service(service, path.group, path.namespace);
          if (existing && ephemeral !== undefined && ephemeral !== existing.ephemeral) {
            return failure(
              `Service "${service}" is ${existing.ephemeral ? 'ephemeral' : 'persistent'}; that cannot be changed. Remove the \`ephemeral\` argument or delete the empty service and create it anew.`,
            );
          }
          // The selector as stored carries bookkeeping fields; only type and expression are Nacos's to take.
          const stored = existing?.selector as { type?: string; expression?: string } | null | undefined;
          const chosen = selector ?? (stored?.type ? { type: stored.type, expression: stored.expression } : { type: 'none' });
          const selectorText = JSON.stringify(chosen);
          const threshold = protect_threshold ?? existing?.protectThreshold ?? 0;
          const metadataString = metadataText(metadata ?? existing?.metadata ?? {});
          if (!existing) {
            await api.createService(service, path.group, path.namespace, ephemeral ?? false, threshold, metadataString, selectorText);
            const created = await api.service(service, path.group, path.namespace);
            return text({
              ...showService(created ?? { ...emptyService(service, path.group), ephemeral: ephemeral ?? false }, path.namespace),
              created: true,
              note: 'Nacos removes a service that has no instances after about a minute. Register an instance to keep it.',
            });
          }
          await api.updateService(service, path.group, path.namespace, threshold, metadataString, selectorText);
          const updated = await api.service(service, path.group, path.namespace);
          return text({ ...showService(updated ?? existing, path.namespace), created: false });
        }),
    );

    server.registerTool(
      'delete_service',
      {
        title: 'Delete an empty service',
        description: 'Delete a service. Nacos refuses while the service still has instances; deregister them first.',
        inputSchema: { service: z.string().min(1), group: groupParam, namespace: namespaceParam, confirm: confirmParam },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ service, group, namespace, confirm }) =>
        guard(async () => {
          const path = await servicePath(group, namespace);
          const existing = await api.service(service, path.group, path.namespace);
          if (!existing)
            return failure(`Service "${service}" in group "${path.group}" of namespace "${path.namespace || 'public'}" does not exist.`);
          const instances = await api.instances(service, path.group, path.namespace);
          if (instances.length > 0) {
            return failure(
              `Service "${service}" still has ${instances.length} instance(s) (${instances.map((item) => `${item.ip}:${item.port}`).join(', ')}). Deregister them first.`,
            );
          }
          if (!confirm) {
            return failure(
              `Refused: deleting service "${service}" in group "${path.group}" removes its settings. Call again with confirm: true once the user agrees.`,
            );
          }
          await api.deleteService(service, path.group, path.namespace);
          return text({ deleted: true, service, group: path.group, namespace: path.namespace || 'public' });
        }),
    );

    // ---- instances ----

    const instancePath = async (group: string | undefined, namespace: string | undefined, ip: string, port: number) => ({
      ...(await servicePath(group, namespace)),
      ip,
      port,
    });

    const showInstance = (instance: Instance, extra: Record<string, unknown> = {}) => ({
      ...extra,
      instance: {
        ip: instance.ip,
        port: instance.port,
        cluster: instance.cluster,
        weight: instance.weight,
        healthy: instance.healthy,
        enabled: instance.enabled,
        ephemeral: instance.ephemeral,
        metadata: instance.metadata,
      },
    });

    server.registerTool(
      'register_instance',
      {
        title: 'Register an instance',
        description:
          'Register an instance with a service, creating the service if needed. The instance takes the kind of the service (ephemeral or persistent). ' +
          'An ephemeral instance registered this way is removed again after about 30 seconds, because nothing sends heartbeats for it; one on a persistent service stays until deregistered. ' +
          'Useful to add a test endpoint, or to see how a service behaves with another instance.',
        inputSchema: {
          service: z.string().min(1),
          ip: z.string().min(1),
          port: z.number().int().min(1).max(65535),
          group: groupParam,
          namespace: namespaceParam,
          cluster: z.string().min(1).optional().describe('Cluster name, "DEFAULT" by default.'),
          weight: z.number().min(0).max(10_000).optional().describe('Weight, 1 by default.'),
          enabled: z.boolean().optional().describe('Whether applications get this instance, true by default.'),
          metadata: metadataParam,
          ephemeral: z
            .boolean()
            .optional()
            .describe(
              'When the service does not exist yet: true creates it as applications do (the default), false as a persistent service.',
            ),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      ({ service, ip, port, group, namespace, cluster, weight, enabled, metadata, ephemeral }) =>
        guard(async () => {
          const path = await instancePath(group, namespace, ip, port);
          const existing = await api.service(service, path.group, path.namespace);
          const isEphemeral = ephemeral ?? existing?.ephemeral ?? true;
          const instance: Instance = {
            ip,
            port,
            cluster: cluster ?? 'DEFAULT',
            weight: weight ?? 1,
            enabled: enabled ?? true,
            healthy: true,
            ephemeral: isEphemeral,
            metadata: metadata ?? {},
          };
          await api.registerInstance(service, path.group, path.namespace, instance);
          const visible = await until(() => api.instance(service, path.group, path.namespace, ip, port), SETTLE_MS);
          return text({
            ...showInstance(visible?.value ?? instance, {
              service,
              group: path.group,
              namespace: path.namespace || 'public',
              created_service: !existing,
              visible_after_ms: visible?.waitedMs ?? null,
            }),
            ...(isEphemeral ? { note: 'This instance is ephemeral: without heartbeats Nacos removes it after about 30 seconds.' } : {}),
          });
        }),
    );

    server.registerTool(
      'update_instance',
      {
        title: 'Update an instance',
        description:
          'Change the weight, whether the instance is enabled, or the metadata of an instance. Fields that are left out keep their current values. ' +
          'Setting enabled to false takes the instance out of what applications get, without deregistering it; true puts it back.',
        inputSchema: {
          service: z.string().min(1),
          ip: z.string().min(1),
          port: z.number().int().min(1).max(65535),
          group: groupParam,
          namespace: namespaceParam,
          weight: z.number().min(0).max(10_000).optional(),
          enabled: z.boolean().optional().describe('false takes the instance out of rotation, true puts it back.'),
          metadata: metadataParam.describe('The complete new metadata; it replaces the existing metadata.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      ({ service, ip, port, group, namespace, weight, enabled, metadata }) =>
        guard(async () => {
          const path = await instancePath(group, namespace, ip, port);
          const current = await api.instance(service, path.group, path.namespace, ip, port);
          if (!current) {
            const known = await api.instances(service, path.group, path.namespace);
            return failure(
              `Instance ${ip}:${port} is not registered with service "${service}" in group "${path.group}".` +
                (known.length ? ` Registered: ${known.map((item) => `${item.ip}:${item.port}`).join(', ')}.` : ''),
            );
          }
          const next: Instance = {
            ...current,
            weight: weight ?? current.weight,
            enabled: enabled ?? current.enabled,
            metadata: metadata ?? current.metadata,
          };
          await api.writeInstance(service, path.group, path.namespace, next);
          const applied = await until(async () => {
            const now = await api.instance(service, path.group, path.namespace, ip, port);
            return now &&
              now.weight === next.weight &&
              now.enabled === next.enabled &&
              metadataText(now.metadata) === metadataText(next.metadata)
              ? now
              : undefined;
          }, SETTLE_MS);
          return text({
            ...showInstance(applied?.value ?? next, {
              service,
              group: path.group,
              namespace: path.namespace || 'public',
              visible: applied !== undefined,
            }),
          });
        }),
    );

    server.registerTool(
      'deregister_instance',
      {
        title: 'Deregister an instance',
        description:
          'Remove an instance from a service. An application that is still running registers itself again right away, so this is for instances that should be gone.',
        inputSchema: {
          service: z.string().min(1),
          ip: z.string().min(1),
          port: z.number().int().min(1).max(65535),
          group: groupParam,
          namespace: namespaceParam,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ service, ip, port, group, namespace }) =>
        guard(async () => {
          const path = await instancePath(group, namespace, ip, port);
          const current = await api.instance(service, path.group, path.namespace, ip, port);
          // Nacos answers "ok" for an instance it does not know; that would look like a removal that never happened.
          if (!current) return failure(`Instance ${ip}:${port} is not registered with service "${service}" in group "${path.group}".`);
          await api.deregisterInstance(service, path.group, path.namespace, current);
          const gone = await until(
            async () => ((await api.instance(service, path.group, path.namespace, ip, port)) ? undefined : true),
            SETTLE_MS,
          );
          return text({
            deregistered: true,
            service,
            group: path.group,
            namespace: path.namespace || 'public',
            instance: { ip, port },
            gone: gone !== undefined,
          });
        }),
    );

    // ---- configurations ----

    server.registerTool(
      'publish_config',
      {
        title: 'Publish a configuration',
        description:
          'Publish a configuration, which creates it or replaces its content; applications pick the change up by themselves. ' +
          'To change an existing configuration, read it first and pass its md5 as expected_md5: publishing is then refused if someone changed it in the meantime. ' +
          'The format, description and tags of an existing configuration are kept unless given. A configuration cannot exceed about 100 KB.',
        inputSchema: {
          data_id: z.string().min(1),
          group: groupParam,
          namespace: namespaceParam,
          content: z.string().describe('The complete new content.'),
          type: z
            .enum(['yaml', 'properties', 'json', 'text', 'xml', 'html'])
            .optional()
            .describe('Format, kept from the existing configuration; "text" for a new one.'),
          expected_md5: z
            .string()
            .length(32)
            .optional()
            .describe('The md5 read with get_config. Publishing is refused when the configuration has changed since.'),
          description: z.string().optional().describe('Description shown in the console.'),
          tags: z.array(z.string()).optional().describe('Labels for filtering in the console.'),
          app_name: z.string().optional().describe('Name of the application the configuration belongs to.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ data_id, group, namespace, content, type, expected_md5, description, tags, app_name }) =>
        guard(async () => {
          if (Buffer.byteLength(content, 'utf8') > 100_000) {
            return failure(
              `The content is ${Math.round(Buffer.byteLength(content, 'utf8') / 1024)} KB; Nacos refuses configurations over about 100 KB.`,
            );
          }
          // An unknown namespace would still take the configuration, which then sits where nobody sees it.
          const path = await configPath(group, namespace);
          const current = await api.getConfig(data_id, path.group, path.namespace);
          if (expected_md5) {
            if (!current)
              return failure(
                `expected_md5 was given, but configuration "${data_id}" in group "${path.group}" does not exist. Leave it out to create the configuration.`,
              );
            if (current.md5 !== expected_md5) {
              return failure(
                `Configuration "${data_id}" in group "${path.group}" has changed since it was read: its md5 is now ${current.md5} (modified ${current.modifiedAt ?? 'unknown'}), not ${expected_md5}. ` +
                  'Read it again with get_config and decide how the changes go together.',
              );
            }
          }
          await api.publishConfig({
            dataId: data_id,
            group: path.group,
            tenant: path.namespace,
            content,
            type: type ?? current?.type,
            casMd5: expected_md5,
            desc: description ?? current?.description,
            config_tags: tags?.join(','),
            appName: app_name ?? current?.appName,
          });
          // Nacos applies a publication asynchronously; until then reads still return the previous content.
          const expected = md5(content);
          const readable = await until(
            async () => ((await api.getConfig(data_id, path.group, path.namespace))?.md5 === expected ? true : undefined),
            SETTLE_MS,
          );
          return text({
            data_id,
            group: path.group,
            namespace: path.namespace || 'public',
            type: type ?? current?.type ?? 'text',
            md5: expected,
            created: current === undefined,
            readable_after_ms: readable?.waitedMs ?? null,
            ...(readable ? {} : { note: 'Nacos still served the previous content after 5 seconds; it should catch up shortly.' }),
          });
        }),
    );

    server.registerTool(
      'delete_config',
      {
        title: 'Delete a configuration',
        description: 'Delete a configuration. Applications that use it keep their last copy. The history is deleted with it.',
        inputSchema: { data_id: z.string().min(1), group: groupParam, namespace: namespaceParam, confirm: confirmParam },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ data_id, group, namespace, confirm }) =>
        guard(async () => {
          const path = await configPath(group, namespace);
          const current = await api.getConfig(data_id, path.group, path.namespace);
          if (!current) return configFailure(data_id, path.group, path.namespace);
          if (!confirm) {
            return failure(
              `Refused: deleting configuration "${data_id}" in group "${path.group}" cannot be undone. Show it to the user (get_config) and call again with confirm: true once they agree.`,
            );
          }
          await api.deleteConfig(data_id, path.group, path.namespace);
          const gone = await until(async () => ((await api.getConfig(data_id, path.group, path.namespace)) ? undefined : true), SETTLE_MS);
          return text({ deleted: true, data_id, group: path.group, namespace: path.namespace || 'public', gone: gone !== undefined });
        }),
    );

    // ---- any other request ----

    server.registerTool(
      'request',
      {
        title: 'Send any request to the Nacos API',
        description:
          'Send any request to the Nacos HTTP API, for what the other tools do not cover: cluster nodes, metrics, switches, listeners, subscribers, users, roles and permissions, import, export, clone. ' +
          'The access token is attached by the server. Answers are JSON when Nacos sends JSON (password hashes removed), text otherwise, and base64 for binary data such as exports. ' +
          'Requests that delete, or that change who may log in, need `confirm`. ' +
          'Two that are easy to get wrong: to clone configurations send POST v1/cs/configs?clone=true&tenant=<target namespace>&policy=ABORT|SKIP|OVERWRITE with a JSON array of { cfgId, dataId, group } as taken from list_configs; ' +
          'to import an export send POST v1/cs/configs?import=true&tenant=<target>&policy=… as multipart with the zip as `file`. ' +
          'For an export (GET v1/cs/configs?export=true) pass group, appName, dataId and ids all, even when empty.',
        inputSchema: {
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('HTTP method.'),
          path: z
            .string()
            .min(1)
            .describe(
              'API path with or without the context path, e.g. "v1/ns/operator/metrics" or "/nacos/v1/ns/operator/metrics"; a query string may be part of it.',
            ),
          query: z.record(z.string(), z.unknown()).optional().describe('Query parameters.'),
          body: requestBody,
          body_type: z
            .enum(['form', 'json', 'text', 'multipart'])
            .default('form')
            .describe('How the body is sent; Nacos takes form data for almost everything.'),
          confirm: confirmParam,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ method, path, query, body, body_type, confirm }) =>
        guard(async () => {
          // Judged before anything else about the request is looked at, so that nothing slips past it.
          const danger = dangerOf(method, path, query);
          if (danger && !confirm) {
            return failure(`Refused: this request ${danger}. Show it to the user and call again with confirm: true once they agree.`);
          }
          return showReply(method, path, { query: queryOf(path, query), ...bodyOptions(body_type, body) });
        }),
    );
  }

  server.registerTool(
    'list_configs',
    {
      title: 'List configurations',
      description:
        'List the configurations of a namespace, filtered by data id and group. A word matches anywhere in the name; "*" is a wildcard. ' +
        'The content is left out here: take it with get_config.',
      inputSchema: {
        namespace: namespaceParam,
        data_id: z.string().min(1).optional().describe('Data id to look for, with or without "*" wildcards.'),
        group: groupParam,
        page: pageParam,
        page_size: pageSizeParam,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ namespace, data_id, group, page, page_size }) =>
      guard(async () => {
        const id = await api.namespaceId(namespace);
        const found = await api.configs(id, data_id, group, page, page_size);
        return present({
          namespace: id || 'public',
          page,
          pages: found.pages,
          total: found.total,
          configs: found.configs.map((item) => ({
            id: item.id,
            data_id: item.dataId,
            group: item.group,
            type: item.type,
            ...(item.appName ? { app_name: item.appName } : {}),
          })),
        });
      }),
  );

  server.registerTool(
    'get_config',
    {
      title: 'Read a configuration',
      description:
        'Read one configuration: its content, format, md5, and when and from where it was created and last changed. The md5 is what publish_config expects as expected_md5.',
      inputSchema: { data_id: z.string().min(1), group: groupParam, namespace: namespaceParam },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ data_id, group, namespace }) =>
      guard(async () => {
        const path = await configPath(group, namespace);
        const found = await api.getConfig(data_id, path.group, path.namespace);
        if (!found) return configFailure(data_id, path.group, path.namespace);
        return present({ ...showConfig(found), namespace: path.namespace || 'public', content: clip(found.content, 60_000) });
      }),
  );

  server.registerTool(
    'config_history',
    {
      title: 'List the versions of a configuration',
      description:
        'List the earlier versions of a configuration, newest first, each with its content, md5, who changed it and from which address. ' +
        'Nacos keeps a version from the moment it is replaced, so the current content may not be among them; `is_current` tells which version is the current one. ' +
        'There is no rollback API: to restore a version, publish its content with publish_config.',
      inputSchema: {
        data_id: z.string().min(1),
        group: groupParam,
        namespace: namespaceParam,
        page: pageParam,
        page_size: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ data_id, group, namespace, page, page_size }) =>
      guard(async () => {
        const path = await configPath(group, namespace);
        const current = await api.getConfig(data_id, path.group, path.namespace);
        if (!current) return configFailure(data_id, path.group, path.namespace);
        const found = await api.configVersions(data_id, path.group, path.namespace, page, page_size);
        return present({
          data_id,
          group: path.group,
          namespace: path.namespace || 'public',
          page,
          total: found.total,
          current_md5: current.md5,
          versions: found.versions.map((version) => ({
            id: version.id,
            change:
              version.opType === 'I' ? 'created' : version.opType === 'D' ? 'deleted' : version.opType === 'U' ? 'updated' : version.opType,
            replaced_at: version.replacedAt,
            from: [version.sourceIp, version.sourceUser].filter(Boolean).join(' / ') || undefined,
            md5: version.md5,
            is_current: version.md5 === current.md5,
            content: clip(version.content, 2_000),
          })),
        });
      }),
  );

  server.registerTool(
    'read_request',
    {
      title: 'Send a GET request to the Nacos API',
      description:
        'Send a GET request to the Nacos API and return what it answers, for everything the other tools do not cover: cluster nodes, metrics, switches, listeners, subscribers, users, roles, permissions, v2 APIs. ' +
        'GET requests do not change anything on Nacos; use request for the other methods. The access token is attached by the server. Answers are JSON when Nacos sends JSON (password hashes removed), text otherwise, and base64 for binary data such as exports.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('API path with or without the context path, e.g. "v1/ns/operator/metrics"; a query string may be part of it.'),
        query: z.record(z.string(), z.unknown()).optional().describe('Query parameters.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ path, query }) => guard(async () => showReply('GET', path, { query: queryOf(path, query) })),
  );
}

function emptyService(name: string, group: string): Service {
  return { name, group, protectThreshold: 0, selector: null, metadata: {}, clusters: [], ephemeral: false };
}

/** Turns the body of the generic request tool into what the client sends. */
function bodyOptions(type: 'form' | 'json' | 'text' | 'multipart', body: unknown): Pick<RequestOptions, 'form' | 'body' | 'contentType'> {
  if (body === undefined || body === null) return {};
  if (type === 'text') {
    return { body: typeof body === 'string' ? body : JSON.stringify(body, null, 2), contentType: 'text/plain' };
  }
  if (type === 'json') {
    return { body: typeof body === 'string' ? body : JSON.stringify(body), contentType: 'application/json' };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`A ${type} body must be an object, got ${Array.isArray(body) ? 'an array' : typeof body}.`);
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (type === 'form') {
    const form: Record<string, FormValue> = {};
    for (const [key, value] of entries) {
      if (value !== null && value !== undefined) form[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return { form };
  }
  const data = new FormData();
  for (const [key, value] of entries) {
    const file = value as { base64?: unknown; filename?: unknown } | null;
    if (typeof file?.base64 === 'string') {
      data.append(key, new Blob([Buffer.from(file.base64, 'base64')]), typeof file.filename === 'string' ? file.filename : key);
    } else if (value !== null && value !== undefined) {
      data.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return { body: data };
}
