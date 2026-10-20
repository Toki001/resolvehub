import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../application/database.service.js';
import { ContractValidator } from '../application/validator.js';
import { ApiFault, unavailable } from '../application/fault.js';
import { tokenDigest } from './crypto.js';
import type { Identity } from './context.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ContractValidator) private readonly validator: ContractValidator,
  ) {}

  async authenticate(header: string | undefined): Promise<Identity> {
    const match = header?.match(/^Bearer (rh_[A-Za-z0-9_-]{43})$/);
    const token = match?.[1];
    if (!token) throw new ApiFault(401, 'UNAUTHENTICATED', 'Authentication is required.');
    let record: unknown;
    try {
      record = await this.database.store.authenticate(tokenDigest(token));
    } catch {
      throw unavailable();
    }
    if (!record) throw new ApiFault(401, 'UNAUTHENTICATED', 'Authentication is required.');
    return this.validator.validate('Identity', record, true);
  }
}
