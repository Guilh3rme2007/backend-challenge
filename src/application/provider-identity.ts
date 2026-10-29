export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

export interface ProviderIdentityPort {
  authorize(providerId: string): Promise<boolean>;
}
