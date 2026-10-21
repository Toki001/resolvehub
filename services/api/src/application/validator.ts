import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import { parse } from 'yaml';
import { z } from 'zod';
import type { components } from '@resolvehub/generated';
import { ApiFault } from './fault.js';

type Schemas = components['schemas'];
const documentSchema = z.object({
  components: z.object({ schemas: z.record(z.string(), z.record(z.string(), z.json())) }),
});

@Injectable()
export class ContractValidator {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });

  constructor() {
    formatsPlugin.default(this.ajv);
    const document = documentSchema.parse(
      parse(
        readFileSync(
          createRequire(import.meta.url).resolve('@resolvehub/contracts/openapi.yaml'),
          'utf8',
        ),
      ),
    );
    this.ajv.addSchema({ $id: 'urn:resolvehub:api', components: document.components });
  }

  validate<K extends keyof Schemas>(name: K, value: unknown, response = false): Schemas[K] {
    const validate = this.ajv.compile<Schemas[K]>({
      $ref: `urn:resolvehub:api#/components/schemas/${name}`,
    });
    if (!validate(value)) {
      if (response) throw new ApiFault(500, 'INTERNAL_ERROR', 'Response violated its contract.');
      throw new ApiFault(400, 'INVALID_INPUT', 'Request is invalid.', {
        fields: (validate.errors ?? [])
          .slice(0, 20)
          .map((error) => ({ path: error.instancePath, rule: error.keyword })),
      });
    }
    return value;
  }
}
