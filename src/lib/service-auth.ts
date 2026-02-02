import type { Environment } from '../types';

export interface ServiceCredentials {
  serviceId: string;
  apiKey: string;
  allowedServices: string[];
  allowedScopes: string[];
}

const SERVICE_REGISTRY: Record<string, ServiceCredentials> = {
  'service:user': {
    serviceId: 'service:user',
    apiKey: '', // Set via env
    allowedServices: ['service:auth', 'service:organization', 'service:billing'],
    allowedScopes: ['users:*', 'profiles:*'],
  },
  'service:organization': {
    serviceId: 'service:organization',
    apiKey: '', // Set via env
    allowedServices: ['service:auth', 'service:user', 'service:billing'],
    allowedScopes: ['organizations:*', 'contexts:*'],
  },
  'service:billing': {
    serviceId: 'service:billing',
    apiKey: '', // Set via env
    allowedServices: ['service:auth', 'service:user', 'service:organization'],
    allowedScopes: ['billing:*', 'subscriptions:*'],
  },
  'service:notification': {
    serviceId: 'service:notification',
    apiKey: '', // Set via env
    allowedServices: ['service:auth', 'service:user', 'service:organization'],
    allowedScopes: ['notifications:*', 'emails:*'],
  },
  'service:product': {
    serviceId: 'service:product',
    apiKey: '', // Set via env
    allowedServices: ['service:auth', 'service:organization'],
    allowedScopes: ['products:*', 'crawls:*'],
  },
};

export const loadServiceCredentials = (env: Environment): Record<string, ServiceCredentials> => {
  const registry = { ...SERVICE_REGISTRY };

  registry['service:user'].apiKey = env.SERVICE_API_KEY_USER || '';
  registry['service:organization'].apiKey = env.SERVICE_API_KEY_ORGANIZATION || '';
  registry['service:billing'].apiKey = env.SERVICE_API_KEY_BILLING || '';
  registry['service:notification'].apiKey = env.SERVICE_API_KEY_NOTIFICATION || '';
  registry['service:product'].apiKey = env.SERVICE_API_KEY_PRODUCT || '';

  return registry;
};

export const verifyServiceApiKey = (
  registry: Record<string, ServiceCredentials>,
  apiKey: string
): ServiceCredentials | null => {
  for (const serviceId in registry) {
    if (registry[serviceId].apiKey === apiKey && apiKey !== '') {
      return registry[serviceId];
    }
  }
  return null;
};

export const canServiceAccess = (
  service: ServiceCredentials,
  targetService: string,
  scope: string
): boolean => {
  if (!service.allowedServices.includes(targetService)) {
    return false;
  }

  const hasScope = service.allowedScopes.some(allowedScope => {
    if (allowedScope.endsWith(':*')) {
      const prefix = allowedScope.slice(0, -2);
      return scope.startsWith(prefix);
    }
    return allowedScope === scope;
  });

  return hasScope;
};

export const generateServiceApiKey = (): string => {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return `crow_svc_${Array.from(array, b => b.toString(16).padStart(2, '0')).join('')}`;
};
