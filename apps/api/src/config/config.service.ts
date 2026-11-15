import { SECRET_KEYS, type AppConfig } from './app-config.schema.js';

export const MASK = '********';

/** The loaded configuration. Provided with a factory, so it carries no DI metadata. */
export class ConfigService {
  constructor(readonly values: AppConfig) {}

  get loginEnabled(): boolean {
    return Boolean(this.values.AdminUser && this.values.AdminPassword);
  }

  get githubEnabled(): boolean {
    const { SupabaseUrl, SupabasePublishableKey, AllowedUserIds, PublicUrl } = this.values;

    return Boolean(SupabaseUrl && SupabasePublishableKey && AllowedUserIds.length && PublicUrl);
  }

  /** Login tokens are issued by the admin login or by GitHub sign-in. */
  get tokensEnabled(): boolean {
    return this.loginEnabled || this.githubEnabled;
  }

  get authEnabled(): boolean {
    return Boolean(this.values.ApiKey) || this.tokensEnabled;
  }

  /** The config with every secret replaced by a mask (or left empty when unset). */
  masked(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.values).map(([key, value]) => [
        key,
        SECRET_KEYS.has(key as keyof AppConfig) ? (value ? MASK : '') : value,
      ]),
    );
  }
}
