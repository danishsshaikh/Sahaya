import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@openmaic\/dsl\/schema\/(.*)$/,
        replacement: resolve(__dirname, 'packages/@openmaic/dsl/dist/schema/$1'),
      },
      {
        find: /^@openmaic\/dsl$/,
        replacement: resolve(__dirname, 'packages/@openmaic/dsl/dist/index.js'),
      },
      {
        find: /^@openmaic\/generation$/,
        replacement: resolve(__dirname, 'packages/@openmaic/generation/src/index.ts'),
      },
      {
        find: /^@openmaic\/renderer\/snapshot$/,
        replacement: resolve(__dirname, 'packages/@openmaic/renderer/dist/snapshot/index.js'),
      },
      {
        find: /^@openmaic\/renderer\/fonts\.css$/,
        replacement: resolve(__dirname, 'packages/@openmaic/renderer/dist/fonts.css'),
      },
      {
        find: /^@openmaic\/renderer$/,
        replacement: resolve(__dirname, 'packages/@openmaic/renderer/dist/index.js'),
      },
      { find: /^@\/(.*)$/, replacement: `${resolve(__dirname, '.')}/$1` },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
  },
});
