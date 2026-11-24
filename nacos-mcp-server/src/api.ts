import {createHash, randomUUID} from 'node:crypto';
import type {Config} from './config.js';
import {Failure, failureOf, Nacos, type Reply, type RequestOptions} from './nacos.js';

/** JSON as Nacos sends it: objects of loosely typed values. */
type Json = Record<string, any>;

export const DEFAULT_GROUP = 'DEFAULT_GROUP';

export interface Namespace {
  /** "" for the public namespace. */
  id: string;
  name: string;
  description: string;
  configCount: number;
  quota: number;
}

export interface ServiceOverview {
  name: string;
  group: string;
  clusters: number;
  instances: number;
  healthyInstances: number;
  protectionTriggered: boolean;
}

export interface Cluster {
  name: string;
  healthCheck: string;
  checkPort: number;
  useInstancePortForCheck: boolean;
  metadata: Record<string, string>;
}

export interface Service {
  name: string;
  group: string;
  protectThreshold: number;
  selector: unknown;
  metadata: Record<string, string>;
  clusters: Cluster[];
  /** undefined when the server does not tell. */
  ephemeral?: boolean;
}

export interface Instance {
  ip: string;
  port: number;
  cluster: string;
  weight: number;
  healthy: boolean;
  enabled: boolean;
  ephemeral: boolean;
  metadata: Record<string, string>;
}

export interface ConfigSummary {
  id: string;
  dataId: string;
  group: string;
  type: string;
  appName?: string;
  tags?: string;
}

export interface ConfigDetail extends ConfigSummary {
  md5: string;
  content: string;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  createdFrom?: string;
  description?: string;
}

export interface ConfigVersion {
  id: string;
  /** I = created, U = updated, D = deleted: the change that replaced this version. */
  opType: string;
  replacedAt?: string;
  sourceIp?: string;
  sourceUser?: string;
  md5: string;
  content: string;
}

/**
 * The Nacos API as this server uses it. Every function stands for one call or one small
 * sequence of calls, and each hides the quirks that were found by trying them out:
 * the parameters the public namespace needs, answers that are empty where an error would be
 * expected, updates that reset whatever is not repeated, and so on.
 */
export class Api {
  readonly nacos: Nacos;

  constructor(readonly config: Config) {
    this.nacos = new Nacos(config);
  }

  /** Sends a request and turns any error answer into a Failure. */
  async call(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    const reply = await this.nacos.send(method, path, options);
    if (reply.status >= 400) throw failureOf(reply, path, this.config);
    return reply;
  }

  async json<T extends object = Json>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const body = (await this.call(method, path, options)).body.toString('utf8');
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Failure(`Nacos did not answer "${path}" with JSON as expected, but with: ${body.slice(0, 200) || 'an empty body'}`, 'api');
    }
  }

  /** For calls that answer "true", "false" or "ok" as plain text or JSON. */
  async acknowledged(method: string, path: string, options: RequestOptions = {}): Promise<string> {
    return (await this.call(method, path, options)).body.toString('utf8').trim();
  }

  // ---- namespaces ----

  async namespaces(): Promise<Namespace[]> {
    const reply = await this.json('GET', 'v1/console/namespaces');
    return (reply.data ?? []).map((item: Json) => ({
      id: String(item.namespace ?? ''),
      name: String(item.namespaceShowName ?? ''),
      description: String(item.namespaceDesc ?? ''),
      configCount: Number(item.configCount ?? 0),
      quota: Number(item.quota ?? 0),
    }));
  }

  /** Accepts the id or the name of a namespace. Nothing, "" and "public" all mean the public namespace, whose id is "". */
  async namespaceId(namespace?: string): Promise<string> {
    if (!namespace || namespace === 'public') return '';
    const all = await this.namespaces();
    const byId = all.find((item) => item.id === namespace);
    if (byId) return byId.id;
    const byName = all.filter((item) => item.name === namespace);
    const named = byName.length === 1 ? byName[0] : undefined;
    if (named) return named.id;
    if (byName.length > 1) throw new Error(`Several namespaces are called "${namespace}"; use an id instead.`);
    // Guessing here would silently create data in a namespace nobody can see in the console.
    const known = all.filter((item) => item.id).map((item) => `${item.name} (${item.id})`);
    throw new Error(`Namespace "${namespace}" does not exist.${known.length ? ` Known namespaces: ${known.join(', ')}.` : ''}`);
  }

  async createNamespace(id: string, name: string, description: string): Promise<void> {
    const answer = await this.acknowledged('POST', 'v1/console/namespaces', {
      form: { customNamespaceId: id, namespaceName: name, namespaceDesc: description },
    });
    // A failed creation is reported as "false", not as an error status.
    if (answer !== 'true') throw new Failure(`Nacos did not create namespace "${name}": ${answer}`, 'api');
  }

  async updateNamespace(id: string, name: string, description: string): Promise<void> {
    await this.acknowledged('PUT', 'v1/console/namespaces', {
      form: { namespace: id, namespaceShowName: name, namespaceDesc: description },
    });
  }

  async deleteNamespace(id: string): Promise<void> {
    await this.acknowledged('DELETE', 'v1/console/namespaces', { query: { namespaceId: id } });
  }

  // ---- services ----

  /** Every group at once, the way the console lists services. The list is refreshed about every second. */
  async services(
    namespace: string,
    group: string | undefined,
    keyword: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; services: ServiceOverview[] }> {
    const reply = await this.json('GET', 'v1/ns/catalog/services', {
      query: {
        hasIpCount: 'true',
        withInstances: 'false',
        namespaceId: namespace,
        pageNo: page,
        pageSize,
        serviceNameParam: keyword ?? '',
        groupNameParam: group ?? '',
      },
    });
    const services: ServiceOverview[] = (reply.serviceList ?? [])
      .filter((item: Json) => group === undefined || item.groupName === group)
      .map((item: Json) => ({
        name: String(item.name),
        group: String(item.groupName),
        clusters: Number(item.clusterCount ?? 0),
        instances: Number(item.ipCount ?? 0),
        healthyInstances: Number(item.healthyInstanceCount ?? 0),
        protectionTriggered: String(item.triggerFlag) === 'true',
      }));
    return { total: Number(reply.count ?? services.length), services };
  }

  /** undefined when there is no such service. */
  async service(name: string, group: string, namespace: string): Promise<Service | undefined> {
    const path = 'v1/ns/catalog/service';
    const reply = await this.nacos.send('GET', path, { query: { serviceName: name, groupName: group, namespaceId: namespace } });
    if (reply.status === 404 && /not found/i.test(reply.body.toString('utf8'))) return undefined;
    if (reply.status >= 400) throw failureOf(reply, path, this.config);
    const detail = JSON.parse(reply.body.toString('utf8')) as Json;
    const service: Service = {
      name: String(detail.service?.name ?? name),
      group: String(detail.service?.groupName ?? group),
      protectThreshold: Number(detail.service?.protectThreshold ?? 0),
      selector: detail.service?.selector ?? null,
      metadata: parseMetadata(detail.service?.metadata),
      clusters: (detail.clusters ?? []).map((cluster: Json) => ({
        name: String(cluster.name),
        healthCheck: String(cluster.healthChecker?.type ?? 'TCP'),
        checkPort: Number(cluster.defaultCheckPort ?? 80),
        useInstancePortForCheck: Boolean(cluster.useIPPort4Check),
        metadata: parseMetadata(cluster.metadata),
      })),
    };
    // Only the v2 API tells whether a service is ephemeral; older servers without it leave it unknown.
    try {
      const v2 = await this.json('GET', 'v2/ns/service', { query: { serviceName: name, groupName: group, namespaceId: namespace } });
      service.ephemeral = v2.data?.ephemeral === true;
    } catch (error) {
      if (!(error instanceof Failure) || error.status !== 404) throw error;
    }
    return service;
  }

  /** All instances of a service, disabled ones included: they are left out of the client's view but kept here. */
  async instances(name: string, group: string, namespace: string): Promise<Instance[]> {
    const service = await this.service(name, group, namespace);
    if (!service) return [];
    const found: Instance[] = [];
    for (const cluster of service.clusters) {
      for (let page = 1; ; page++) {
        const reply = await this.json('GET', 'v1/ns/catalog/instances', {
          query: { serviceName: name, clusterName: cluster.name, groupName: group, pageSize: 200, pageNo: page, namespaceId: namespace },
        });
        const list: Json[] = reply.list ?? [];
        found.push(...list.map(toInstance));
        if (list.length === 0 || page * 200 >= Number(reply.count ?? 0)) break;
      }
    }
    return found;
  }

  async instance(name: string, group: string, namespace: string, ip: string, port: number): Promise<Instance | undefined> {
    const all = await this.instances(name, group, namespace);
    return all.find((item) => item.ip === ip && item.port === port);
  }

  async createService(
    name: string,
    group: string,
    namespace: string,
    ephemeral: boolean,
    protectThreshold: number,
    metadata: string,
    selector: string,
  ): Promise<void> {
    const form = { serviceName: name, groupName: group, namespaceId: namespace, protectThreshold, metadata, selector };
    // The v1 API can only create persistent services; an ephemeral one, as applications register them, needs v2.
    await this.acknowledged('POST', ephemeral ? 'v2/ns/service' : 'v1/ns/service', {
      form: ephemeral ? { ...form, ephemeral: 'true' } : form,
    });
  }

  async updateService(
    name: string,
    group: string,
    namespace: string,
    protectThreshold: number,
    metadata: string,
    selector: string,
  ): Promise<void> {
    await this.acknowledged('PUT', 'v1/ns/service', {
      form: { serviceName: name, groupName: group, namespaceId: namespace, protectThreshold, metadata, selector },
    });
  }

  async deleteService(name: string, group: string, namespace: string): Promise<void> {
    await this.acknowledged('DELETE', 'v1/ns/service', { query: { serviceName: name, groupName: group, namespaceId: namespace } });
  }

  // ---- instances ----

  async registerInstance(service: string, group: string, namespace: string, instance: Instance): Promise<void> {
    await this.acknowledged('POST', 'v1/ns/instance', {
      form: {
        serviceName: service,
        groupName: group,
        namespaceId: namespace,
        ip: instance.ip,
        port: instance.port,
        clusterName: instance.cluster,
        weight: instance.weight,
        enabled: instance.enabled,
        // Nacos decides by this flag which kind of service the instance belongs to; leaving it out means ephemeral.
        ephemeral: instance.ephemeral,
        metadata: metadataText(instance.metadata),
      },
    });
  }

  /**
   * Re-registers the instance with every field given. Nacos resets whatever is left out to its
   * default, so the caller has to hand over the complete instance, not just the changes.
   */
  async writeInstance(service: string, group: string, namespace: string, instance: Instance): Promise<void> {
    await this.acknowledged('PUT', 'v1/ns/instance', {
      form: {
        serviceName: service,
        groupName: group,
        namespaceId: namespace,
        ip: instance.ip,
        port: instance.port,
        clusterName: instance.cluster,
        weight: instance.weight,
        enabled: instance.enabled,
        ephemeral: instance.ephemeral,
        metadata: metadataText(instance.metadata),
      },
    });
  }

  async deregisterInstance(service: string, group: string, namespace: string, instance: Instance): Promise<void> {
    await this.acknowledged('DELETE', 'v1/ns/instance', {
      query: {
        serviceName: service,
        groupName: group,
        namespaceId: namespace,
        ip: instance.ip,
        port: instance.port,
        clusterName: instance.cluster,
        ephemeral: instance.ephemeral,
      },
    });
  }

  // ---- configurations ----

  async configs(
    namespace: string,
    dataId: string | undefined,
    group: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; pages: number; configs: ConfigSummary[] }> {
    const reply = await this.json('GET', 'v1/cs/configs', {
      query: {
        search: 'blur',
        dataId: fuzzy(dataId),
        group: fuzzy(group),
        tenant: namespace,
        pageNo: page,
        pageSize,
      },
    });
    const configs: ConfigSummary[] = (reply.pageItems ?? []).map((item: Json) => ({
      id: String(item.id),
      dataId: String(item.dataId),
      group: String(item.group),
      type: String(item.type ?? ''),
      ...(item.appName ? { appName: String(item.appName) } : {}),
    }));
    return { total: Number(reply.totalCount ?? 0), pages: Number(reply.pagesAvailable ?? 0), configs };
  }

  /** undefined when there is no such configuration. */
  async getConfig(dataId: string, group: string, namespace: string): Promise<ConfigDetail | undefined> {
    const path = 'v1/cs/configs';
    const reply = await this.nacos.send('GET', path, { query: { dataId, group, tenant: namespace, show: 'all' } });
    const body = reply.body.toString('utf8');
    // Without "show=all" a missing configuration is answered with 404; with it, Nacos answers 200 and nothing at all.
    const missing = (reply.status === 404 && /not exist/i.test(body)) || (reply.status === 200 && body.trim() === '');
    if (missing) return undefined;
    if (reply.status >= 400) throw failureOf(reply, path, this.config);
    const detail = JSON.parse(body) as Json;
    return {
      id: String(detail.id ?? ''),
      dataId: String(detail.dataId),
      group: String(detail.group),
      type: String(detail.type ?? ''),
      md5: String(detail.md5 ?? md5(String(detail.content ?? ''))),
      content: String(detail.content ?? ''),
      createdAt: instant(detail.createTime),
      modifiedAt: instant(detail.modifyTime),
      ...(detail.createUser ? { createdBy: String(detail.createUser) } : {}),
      ...(detail.createIp ? { createdFrom: String(detail.createIp) } : {}),
      ...(detail.desc ? { description: String(detail.desc) } : {}),
      ...(detail.configTags ? { tags: String(detail.configTags) } : {}),
      ...(detail.appName ? { appName: String(detail.appName) } : {}),
    };
  }

  async publishConfig(form: Record<string, string | undefined>): Promise<void> {
    const answer = await this.acknowledged('POST', 'v1/cs/configs', { form, query: form.casMd5 ? { casMd5: form.casMd5 } : {} });
    if (answer !== 'true') throw new Failure(`Nacos did not publish the configuration: ${answer}`, 'api');
  }

  async deleteConfig(dataId: string, group: string, namespace: string): Promise<void> {
    await this.acknowledged('DELETE', 'v1/cs/configs', { query: { dataId, group, tenant: namespace } });
  }

  /** The versions that were replaced, newest first. Each is read on its own because the list leaves the content out. */
  async configVersions(
    dataId: string,
    group: string,
    namespace: string,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; versions: ConfigVersion[] }> {
    const list = await this.json('GET', 'v1/cs/history', {
      query: { search: 'accurate', dataId, group, tenant: namespace, pageNo: page, pageSize },
    });
    const items: Json[] = list.pageItems ?? [];
    const versions = await Promise.all(
      items.map(async (item) => {
        // An unknown version id is answered with 200 and an empty body rather than an error.
        const reply = await this.nacos.send('GET', 'v1/cs/history', { query: { dataId, group, tenant: namespace, nid: item.id } });
        if (reply.status >= 400) throw failureOf(reply, 'v1/cs/history', this.config);
        const detail = (reply.body.toString('utf8').trim() ? JSON.parse(reply.body.toString('utf8')) : {}) as Json;
        return {
          id: String(item.id),
          opType: String(detail.opType ?? item.opType ?? ''),
          replacedAt: instant(detail.lastModifiedTime ?? item.lastModifiedTime),
          sourceIp: detail.srcIp ? String(detail.srcIp) : undefined,
          sourceUser: detail.srcUser ? String(detail.srcUser) : undefined,
          md5: String(detail.md5 ?? ''),
          content: String(detail.content ?? ''),
        };
      }),
    );
    return { total: Number(list.totalCount ?? 0), versions };
  }
}

function toInstance(item: Json): Instance {
  return {
    ip: String(item.ip),
    port: Number(item.port),
    cluster: String(item.clusterName ?? 'DEFAULT'),
    weight: Number(item.weight ?? 1),
    healthy: item.healthy === true,
    enabled: item.enabled !== false,
    ephemeral: item.ephemeral !== false,
    metadata: parseMetadata(item.metadata),
  };
}

/** Nacos takes metadata as "key=value,key=value"; keys and values with commas or equals signs cannot be expressed that way. */
export function metadataText(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => {
      if (/[,=]/.test(key) || /,/.test(value))
        throw new Error(`Metadata keys must not contain "," or "=", and values no ",": ${key}=${value}`);
      return `${key}=${value}`;
    })
    .join(',');
}

function parseMetadata(value: unknown): Record<string, string> {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

/** A plain word matches anywhere; a pattern with * is taken as it is. */
function fuzzy(value: string | undefined): string {
  if (!value) return '*';
  return value.includes('*') ? value : `*${value}*`;
}

export function md5(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex');
}

/** Nacos gives times as epoch milliseconds in some answers and as text in others. */
function instant(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return undefined;
  const epoch = Number(value);
  if (Number.isFinite(epoch)) return new Date(epoch).toISOString();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

/** Nacos wants an id for a new namespace and offers none itself; the console makes one up the same way. */
export function newNamespaceId(): string {
  return randomUUID().replace(/-/g, '');
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Repeats a check until it holds: Nacos applies changes asynchronously, so reading straight after writing can still show the old state. */
export async function until<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<{ value: T; waitedMs: number } | undefined> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined) return { value, waitedMs: Date.now() - started };
    if (Date.now() - started >= timeoutMs) return undefined;
    await sleep(100);
  }
}
