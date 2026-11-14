import {defineConfig} from 'vite';
import {modelsMiddleware} from './scripts/models-middleware.mjs';
const models=modelsMiddleware(new URL('./models/',import.meta.url).pathname);
export default defineConfig({worker:{format:'es'},build:{chunkSizeWarningLimit:2000},plugins:[{
  name:'omit-unused-default-onnx-runtime',
  generateBundle(_options,bundle){
    // speech-worker pins the self-hosted synchronous runtime prepared before builds.
    // ORT's unused asyncify fallback exceeds static hosts' per-file size limit.
    for(const file of Object.keys(bundle))if(file.endsWith('.wasm')&&file.includes('asyncify'))delete bundle[file];
  },
},{
  // Model files saved by `npm run models` load from this computer (see scripts/fetch-models.mjs).
  name:'serve-local-models',
  configureServer(server){server.middlewares.use(models);},
  configurePreviewServer(server){server.middlewares.use(models);},
}]});
