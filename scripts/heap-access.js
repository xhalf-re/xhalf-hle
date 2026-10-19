// Fresh view on every access: Emscripten replaces HEAPU8 after memory growth.
Module.xhleHeap = () => HEAPU8;
