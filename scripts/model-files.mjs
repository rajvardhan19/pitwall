// The model files the game loads, as Hugging Face repo paths. fetch-models.mjs saves these under
// models/; the dev and preview servers serve them at /models/<path>.
export const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const LLAMA = 'onnx-community/Llama-3.2-1B-Instruct-ONNX';
export const WHISPER = 'onnx-community/whisper-tiny.en';
// Every voice in src/radio-profile.ts (a test keeps this list in step).
export const VOICES = ['af_nicole', 'am_fenrir', 'am_michael', 'am_puck', 'bf_emma', 'bm_fable', 'bm_george'];
export const MODEL_FILES = [
  // Neural radio: fp32 on the GPU (325 MB), q8 on the CPU (92 MB).
  ...['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx', 'onnx/model_quantized.onnx'].map(f => `${KOKORO}/${f}`),
  ...VOICES.map(v => `${KOKORO}/voices/${v}.bin`),
  // Speech recognition for the Talk button: 8-bit encoder and decoder on the CPU (40 MB).
  ...['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'].map(f => `${WHISPER}/${f}`),
  // Team chat: 4-bit weights with half-precision activations (1.09 GB). GPUs without shader-f16
  // need the q4 build instead; that one still downloads in the browser.
  ...['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(f => `${LLAMA}/${f}`),
];
