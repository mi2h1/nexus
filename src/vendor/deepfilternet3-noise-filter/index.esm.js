class AssetLoader {
    constructor(config = {}) {
        this.cdnUrl = config.cdnUrl ?? 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3';
    }
    getCdnUrl(relativePath) {
        return `${this.cdnUrl}/${relativePath}`;
    }
    getAssetUrls() {
        return {
            wasm: this.getCdnUrl('v2/pkg/df_bg.wasm'),
            model: this.getCdnUrl('v2/models/DeepFilterNet3_onnx.tar.gz')
        };
    }
    async fetchAsset(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch asset: ${response.statusText}`);
        }
        return response.arrayBuffer();
    }
}
let defaultLoader = null;
function getAssetLoader(config) {
    if (!defaultLoader || config) {
        defaultLoader = new AssetLoader(config);
    }
    return defaultLoader;
}

/**
 * Creates a worklet module URL from inline code string
 * This approach works with all bundlers without special configuration
 */
async function createWorkletModule(audioContext, workletCode) {
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await audioContext.audioWorklet.addModule(blobUrl);
}

const WorkletMessageTypes = {
    SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',
    SET_BYPASS: 'SET_BYPASS'
};

var workletCode = "(function () {\n    'use strict';\n\n    let wasm;\n\n    const heap = new Array(128).fill(undefined);\n\n    heap.push(undefined, null, true, false);\n\n    function getObject(idx) { return heap[idx]; }\n\n    let heap_next = heap.length;\n\n    function dropObject(idx) {\n        if (idx < 132) return;\n        heap[idx] = heap_next;\n        heap_next = idx;\n    }\n\n    function takeObject(idx) {\n        const ret = getObject(idx);\n        dropObject(idx);\n        return ret;\n    }\n\n    const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );\n\n    if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); }\n    let cachedUint8Memory0 = null;\n\n    function getUint8Memory0() {\n        if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {\n            cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);\n        }\n        return cachedUint8Memory0;\n    }\n\n    function getStringFromWasm0(ptr, len) {\n        ptr = ptr >>> 0;\n        return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));\n    }\n\n    function addHeapObject(obj) {\n        if (heap_next === heap.length) heap.push(heap.length + 1);\n        const idx = heap_next;\n        heap_next = heap[idx];\n\n        heap[idx] = obj;\n        return idx;\n    }\n    /**\n    * Set DeepFilterNet attenuation limit.\n    *\n    * Args:\n    *     - lim_db: New attenuation limit in dB.\n    * @param {number} st\n    * @param {number} lim_db\n    */\n    function df_set_atten_lim(st, lim_db) {\n        wasm.df_set_atten_lim(st, lim_db);\n    }\n\n    /**\n    * Get DeepFilterNet frame size in samples.\n    * @param {number} st\n    * @returns {number}\n    */\n    function df_get_frame_length(st) {\n        const ret = wasm.df_get_frame_length(st);\n        return ret >>> 0;\n    }\n\n    let WASM_VECTOR_LEN = 0;\n\n    function passArray8ToWasm0(arg, malloc) {\n        const ptr = malloc(arg.length * 1, 1) >>> 0;\n        getUint8Memory0().set(arg, ptr / 1);\n        WASM_VECTOR_LEN = arg.length;\n        return ptr;\n    }\n    /**\n    * Create a DeepFilterNet Model\n    *\n    * Args:\n    *     - path: File path to a DeepFilterNet tar.gz onnx model\n    *     - atten_lim: Attenuation limit in dB.\n    *\n    * Returns:\n    *     - DF state doing the full processing: stft, DNN noise reduction, istft.\n    * @param {Uint8Array} model_bytes\n    * @param {number} atten_lim\n    * @returns {number}\n    */\n    function df_create(model_bytes, atten_lim) {\n        const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc);\n        const len0 = WASM_VECTOR_LEN;\n        const ret = wasm.df_create(ptr0, len0, atten_lim);\n        return ret >>> 0;\n    }\n\n    let cachedFloat32Memory0 = null;\n\n    function getFloat32Memory0() {\n        if (cachedFloat32Memory0 === null || cachedFloat32Memory0.byteLength === 0) {\n            cachedFloat32Memory0 = new Float32Array(wasm.memory.buffer);\n        }\n        return cachedFloat32Memory0;\n    }\n\n    function passArrayF32ToWasm0(arg, malloc) {\n        const ptr = malloc(arg.length * 4, 4) >>> 0;\n        getFloat32Memory0().set(arg, ptr / 4);\n        WASM_VECTOR_LEN = arg.length;\n        return ptr;\n    }\n    /**\n    * Processes a chunk of samples.\n    *\n    * Args:\n    *     - df_state: Created via df_create()\n    *     - input: Input buffer of length df_get_frame_length()\n    *     - output: Output buffer of length df_get_frame_length()\n    *\n    * Returns:\n    *     - Local SNR of the current frame.\n    * @param {number} st\n    * @param {Float32Array} input\n    * @returns {Float32Array}\n    */\n    function df_process_frame(st, input) {\n        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);\n        const len0 = WASM_VECTOR_LEN;\n        const ret = wasm.df_process_frame(st, ptr0, len0);\n        return takeObject(ret);\n    }\n\n    function handleError(f, args) {\n        try {\n            return f.apply(this, args);\n        } catch (e) {\n            wasm.__wbindgen_exn_store(addHeapObject(e));\n        }\n    }\n\n    (typeof FinalizationRegistry === 'undefined')\n        ? { }\n        : new FinalizationRegistry(ptr => wasm.__wbg_dfstate_free(ptr >>> 0));\n\n    function __wbg_get_imports() {\n        const imports = {};\n        imports.wbg = {};\n        imports.wbg.__wbindgen_object_drop_ref = function(arg0) {\n            takeObject(arg0);\n        };\n        imports.wbg.__wbg_crypto_566d7465cdbb6b7a = function(arg0) {\n            const ret = getObject(arg0).crypto;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbindgen_is_object = function(arg0) {\n            const val = getObject(arg0);\n            const ret = typeof(val) === 'object' && val !== null;\n            return ret;\n        };\n        imports.wbg.__wbg_process_dc09a8c7d59982f6 = function(arg0) {\n            const ret = getObject(arg0).process;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_versions_d98c6400c6ca2bd8 = function(arg0) {\n            const ret = getObject(arg0).versions;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_node_caaf83d002149bd5 = function(arg0) {\n            const ret = getObject(arg0).node;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbindgen_is_string = function(arg0) {\n            const ret = typeof(getObject(arg0)) === 'string';\n            return ret;\n        };\n        imports.wbg.__wbg_require_94a9da52636aacbf = function() { return handleError(function () {\n            const ret = module.require;\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbindgen_is_function = function(arg0) {\n            const ret = typeof(getObject(arg0)) === 'function';\n            return ret;\n        };\n        imports.wbg.__wbindgen_string_new = function(arg0, arg1) {\n            const ret = getStringFromWasm0(arg0, arg1);\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_msCrypto_0b84745e9245cdf6 = function(arg0) {\n            const ret = getObject(arg0).msCrypto;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_randomFillSync_290977693942bf03 = function() { return handleError(function (arg0, arg1) {\n            getObject(arg0).randomFillSync(takeObject(arg1));\n        }, arguments) };\n        imports.wbg.__wbg_getRandomValues_260cc23a41afad9a = function() { return handleError(function (arg0, arg1) {\n            getObject(arg0).getRandomValues(getObject(arg1));\n        }, arguments) };\n        imports.wbg.__wbg_newnoargs_e258087cd0daa0ea = function(arg0, arg1) {\n            const ret = new Function(getStringFromWasm0(arg0, arg1));\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_new_63b92bc8671ed464 = function(arg0) {\n            const ret = new Uint8Array(getObject(arg0));\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_new_9efabd6b6d2ce46d = function(arg0) {\n            const ret = new Float32Array(getObject(arg0));\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_buffer_12d079cc21e14bdb = function(arg0) {\n            const ret = getObject(arg0).buffer;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb = function(arg0, arg1, arg2) {\n            const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_newwithlength_e9b4878cebadb3d3 = function(arg0) {\n            const ret = new Uint8Array(arg0 >>> 0);\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_set_a47bac70306a19a7 = function(arg0, arg1, arg2) {\n            getObject(arg0).set(getObject(arg1), arg2 >>> 0);\n        };\n        imports.wbg.__wbg_subarray_a1f73cd4b5b42fe1 = function(arg0, arg1, arg2) {\n            const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_newwithbyteoffsetandlength_4a659d079a1650e0 = function(arg0, arg1, arg2) {\n            const ret = new Float32Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_self_ce0dbfc45cf2f5be = function() { return handleError(function () {\n            const ret = self.self;\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbg_window_c6fb939a7f436783 = function() { return handleError(function () {\n            const ret = window.window;\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbg_globalThis_d1e6af4856ba331b = function() { return handleError(function () {\n            const ret = globalThis.globalThis;\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbg_global_207b558942527489 = function() { return handleError(function () {\n            const ret = global.global;\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbindgen_is_undefined = function(arg0) {\n            const ret = getObject(arg0) === undefined;\n            return ret;\n        };\n        imports.wbg.__wbg_call_27c0f87801dedf93 = function() { return handleError(function (arg0, arg1) {\n            const ret = getObject(arg0).call(getObject(arg1));\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbindgen_object_clone_ref = function(arg0) {\n            const ret = getObject(arg0);\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbg_call_b3ca7c6051f9bec1 = function() { return handleError(function (arg0, arg1, arg2) {\n            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));\n            return addHeapObject(ret);\n        }, arguments) };\n        imports.wbg.__wbindgen_memory = function() {\n            const ret = wasm.memory;\n            return addHeapObject(ret);\n        };\n        imports.wbg.__wbindgen_throw = function(arg0, arg1) {\n            throw new Error(getStringFromWasm0(arg0, arg1));\n        };\n\n        return imports;\n    }\n\n    function __wbg_finalize_init(instance, module) {\n        wasm = instance.exports;\n        cachedFloat32Memory0 = null;\n        cachedUint8Memory0 = null;\n\n\n        return wasm;\n    }\n\n    function initSync(module) {\n        if (wasm !== undefined) return wasm;\n\n        const imports = __wbg_get_imports();\n\n        if (!(module instanceof WebAssembly.Module)) {\n            module = new WebAssembly.Module(module);\n        }\n\n        const instance = new WebAssembly.Instance(module, imports);\n\n        return __wbg_finalize_init(instance);\n    }\n\n    const WorkletMessageTypes = {\n        SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',\n        SET_BYPASS: 'SET_BYPASS'\n    };\n\n    class DeepFilterAudioProcessor extends AudioWorkletProcessor {\n        constructor(options) {\n            super();\n            this.dfModel = null;\n            this.inputWritePos = 0;\n            this.inputReadPos = 0;\n            this.outputWritePos = 0;\n            this.outputReadPos = 0;\n            this.bypass = false;\n            this.isInitialized = false;\n            this.tempFrame = null;\n            this.bufferSize = 8192;\n            this.inputBuffer = new Float32Array(this.bufferSize);\n            this.outputBuffer = new Float32Array(this.bufferSize);\n            try {\n                // Initialize WASM from pre-compiled module\n                initSync(options.processorOptions.wasmModule);\n                const modelBytes = new Uint8Array(options.processorOptions.modelBytes);\n                const handle = df_create(modelBytes, options.processorOptions.suppressionLevel ?? 50);\n                const frameLength = df_get_frame_length(handle);\n                this.dfModel = { handle, frameLength };\n                this.bufferSize = frameLength * 4;\n                this.inputBuffer = new Float32Array(this.bufferSize);\n                this.outputBuffer = new Float32Array(this.bufferSize);\n                // Pre-allocate temp frame buffer for processing\n                this.tempFrame = new Float32Array(frameLength);\n                this.isInitialized = true;\n                this.port.onmessage = (event) => {\n                    this.handleMessage(event.data);\n                };\n            }\n            catch (error) {\n                console.error('Failed to initialize DeepFilter in AudioWorklet:', error);\n                this.isInitialized = false;\n            }\n        }\n        handleMessage(data) {\n            switch (data.type) {\n                case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:\n                    if (this.dfModel && typeof data.value === 'number') {\n                        const level = Math.max(0, Math.min(100, Math.floor(data.value)));\n                        df_set_atten_lim(this.dfModel.handle, level);\n                    }\n                    break;\n                case WorkletMessageTypes.SET_BYPASS:\n                    this.bypass = Boolean(data.value);\n                    break;\n            }\n        }\n        getInputAvailable() {\n            return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;\n        }\n        getOutputAvailable() {\n            return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;\n        }\n        process(inputList, outputList) {\n            const sourceLimit = Math.min(inputList.length, outputList.length);\n            const input = inputList[0]?.[0];\n            if (!input) {\n                return true;\n            }\n            // Passthrough mode - copy input to all output channels\n            if (!this.isInitialized || !this.dfModel || this.bypass || !this.tempFrame) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    const channelCount = output.length;\n                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {\n                        output[channelNum].set(input);\n                    }\n                }\n                return true;\n            }\n            // Write input to ring buffer\n            for (let i = 0; i < input.length; i++) {\n                this.inputBuffer[this.inputWritePos] = input[i];\n                this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;\n            }\n            const frameLength = this.dfModel.frameLength;\n            while (this.getInputAvailable() >= frameLength) {\n                // Extract frame from ring buffer\n                for (let i = 0; i < frameLength; i++) {\n                    this.tempFrame[i] = this.inputBuffer[this.inputReadPos];\n                    this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;\n                }\n                const processed = df_process_frame(this.dfModel.handle, this.tempFrame);\n                // Write to output ring buffer\n                for (let i = 0; i < processed.length; i++) {\n                    this.outputBuffer[this.outputWritePos] = processed[i];\n                    this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;\n                }\n            }\n            const outputAvailable = this.getOutputAvailable();\n            if (outputAvailable >= 128) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    const channelCount = output.length;\n                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {\n                        const outputChannel = output[channelNum];\n                        let readPos = this.outputReadPos;\n                        for (let i = 0; i < 128; i++) {\n                            outputChannel[i] = this.outputBuffer[readPos];\n                            readPos = (readPos + 1) % this.bufferSize;\n                        }\n                    }\n                }\n                this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;\n            }\n            return true;\n        }\n    }\n    registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);\n\n})();\n";

class DeepFilterNet3Core {
    constructor(config = {}) {
        this.assets = null;
        this.workletNode = null;
        this.isInitialized = false;
        this.bypassEnabled = false;
        this.config = {
            sampleRate: config.sampleRate ?? 48000,
            noiseReductionLevel: config.noiseReductionLevel ?? 50,
            assetConfig: config.assetConfig
        };
        this.assetLoader = getAssetLoader(config.assetConfig);
    }
    async initialize() {
        if (this.isInitialized)
            return;
        // Fetch and compile WASM on main thread
        const assetUrls = this.assetLoader.getAssetUrls();
        const [wasmBytes, modelBytes] = await Promise.all([
            this.assetLoader.fetchAsset(assetUrls.wasm),
            this.assetLoader.fetchAsset(assetUrls.model)
        ]);
        // Compile WASM module
        const wasmModule = await WebAssembly.compile(wasmBytes);
        this.assets = { wasmModule, modelBytes };
        this.isInitialized = true;
    }
    async createAudioWorkletNode(audioContext) {
        this.ensureInitialized();
        if (!this.assets) {
            throw new Error('Assets not loaded');
        }
        await createWorkletModule(audioContext, workletCode);
        this.workletNode = new AudioWorkletNode(audioContext, 'deepfilter-audio-processor', {
            processorOptions: {
                wasmModule: this.assets.wasmModule,
                modelBytes: this.assets.modelBytes,
                suppressionLevel: this.config.noiseReductionLevel
            }
        });
        return this.workletNode;
    }
    setSuppressionLevel(level) {
        if (!this.workletNode || typeof level !== 'number' || isNaN(level))
            return;
        const clampedLevel = Math.max(0, Math.min(100, Math.floor(level)));
        this.workletNode.port.postMessage({
            type: WorkletMessageTypes.SET_SUPPRESSION_LEVEL,
            value: clampedLevel
        });
    }
    destroy() {
        if (!this.isInitialized)
            return;
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        this.assets = null;
        this.isInitialized = false;
    }
    isReady() {
        return this.isInitialized && this.workletNode !== null;
    }
    setNoiseSuppressionEnabled(enabled) {
        if (!this.workletNode)
            return;
        this.bypassEnabled = !enabled;
        this.workletNode.port.postMessage({
            type: WorkletMessageTypes.SET_BYPASS,
            value: !enabled
        });
    }
    isNoiseSuppressionEnabled() {
        return !this.bypassEnabled;
    }
    ensureInitialized() {
        if (!this.isInitialized) {
            throw new Error('Processor not initialized. Call initialize() first.');
        }
    }
}

class DeepFilterNoiseFilterProcessor {
    constructor(options = {}) {
        this.name = 'deepfilternet3-noise-filter';
        this.audioContext = null;
        this.sourceNode = null;
        this.workletNode = null;
        this.destination = null;
        this.enabled = true;
        this.init = async (opts) => {
            const track = opts.track ?? opts.mediaStreamTrack;
            if (!track) {
                throw new Error('DeepFilterNoiseFilterProcessor.init: missing MediaStreamTrack');
            }
            this.originalTrack = track;
            await this.ensureGraph();
        };
        this.restart = async (opts) => {
            const track = opts.track ?? opts.mediaStreamTrack;
            if (track) {
                this.originalTrack = track;
            }
            await this.ensureGraph();
        };
        this.setEnabled = async (enable) => {
            this.enabled = enable;
            this.processor.setNoiseSuppressionEnabled(enable);
            return this.enabled;
        };
        this.suspend = async () => {
            if (this.audioContext && this.audioContext.state === 'running') {
                await this.audioContext.suspend();
            }
        };
        this.resume = async () => {
            if (this.audioContext && this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        };
        this.destroy = async () => {
            await this.teardownGraph();
            this.processor.destroy();
        };
        const cfg = {
            sampleRate: options.sampleRate ?? 48000,
            noiseReductionLevel: options.noiseReductionLevel ?? 80,
            assetConfig: options.assetConfig
        };
        this.enabled = options.enabled ?? true;
        this.processor = new DeepFilterNet3Core(cfg);
    }
    static isSupported() {
        return typeof AudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
    }
    setSuppressionLevel(level) {
        this.processor.setSuppressionLevel(level);
    }
    isEnabled() {
        return this.enabled;
    }
    isNoiseSuppressionEnabled() {
        return this.processor.isNoiseSuppressionEnabled();
    }
    async ensureGraph() {
        if (!this.originalTrack) {
            throw new Error('No source track');
        }
        this.audioContext ?? (this.audioContext = new AudioContext({ sampleRate: 48000 }));
        if (this.audioContext.state !== 'running') {
            try {
                await this.audioContext.resume();
            }
            catch {
                // Ignore resume errors
            }
        }
        await this.processor.initialize();
        if (!this.workletNode) {
            const node = await this.processor.createAudioWorkletNode(this.audioContext);
            this.workletNode = node;
        }
        if (!this.destination) {
            this.destination = this.audioContext.createMediaStreamDestination();
            this.processedTrack = this.destination.stream.getAudioTracks()[0];
        }
        if (this.sourceNode) {
            this.sourceNode.disconnect();
        }
        this.sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([this.originalTrack]));
        this.sourceNode.connect(this.workletNode).connect(this.destination);
        await this.setEnabled(this.enabled);
    }
    async teardownGraph() {
        try {
            if (this.workletNode) {
                this.workletNode.disconnect();
                this.workletNode = null;
            }
            if (this.sourceNode) {
                this.sourceNode.disconnect();
                this.sourceNode = null;
            }
            if (this.destination) {
                this.destination.disconnect();
                this.destination = null;
            }
            if (this.audioContext) {
                void this.audioContext.close();
                this.audioContext = null;
            }
        }
        catch {
            // Ignore disconnect errors
        }
    }
}
function DeepFilterNoiseFilter(options) {
    return new DeepFilterNoiseFilterProcessor(options);
}

export { AssetLoader, DeepFilterNet3Core, DeepFilterNoiseFilter, DeepFilterNoiseFilterProcessor, getAssetLoader };
