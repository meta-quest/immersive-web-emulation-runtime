import { defineConfig } from 'vite';

// GLTS scripts share the app's three namespace; dedupe so SEM renders the
// environment with the same three instance.
export default defineConfig({ resolve: { dedupe: ['three'] } });
