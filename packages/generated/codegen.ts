import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: '../contracts/schema.graphql',
  documents: ['../contracts/operations/**/*.graphql'],
  generates: {
    'src/graphql/': {
      preset: 'client',
      presetConfig: { fragmentMasking: false },
      config: {
        useTypeImports: true,
        emitLegacyCommonJSImports: false,
        enumsAsTypes: true,
        strictScalars: true,
        scalars: { DateTime: 'string', Cursor: 'string' },
      },
    },
  },
};

export default config;
