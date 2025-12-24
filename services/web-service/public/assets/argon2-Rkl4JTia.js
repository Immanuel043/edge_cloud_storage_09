const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/argon2-BzsZV6pE.js","assets/index-CEtgWK0C.js","assets/index-mdUEr51-.css"])))=>i.map(i=>d[i]);
import { g as _e, a as Pe, c as Be, _ as Ie, __tla as __tla_0 } from "./index-CEtgWK0C.js";
import * as ye from "a";
let Je, Le;
let __tla = Promise.all([
    (()=>{
        try {
            return __tla_0;
        } catch  {}
    })()
]).then(async ()=>{
    function Oe(m, e) {
        for(var c = 0; c < e.length; c++){
            const s = e[c];
            if (typeof s != "string" && !Array.isArray(s)) {
                for(const l in s)if (l !== "default" && !(l in m)) {
                    const u = Object.getOwnPropertyDescriptor(s, l);
                    u && Object.defineProperty(m, l, u.get ? u : {
                        enumerable: !0,
                        get: ()=>s[l]
                    });
                }
            }
        }
        return Object.freeze(Object.defineProperty(m, Symbol.toStringTag, {
            value: "Module"
        }));
    }
    function pe(m) {
        throw new Error('Could not dynamically require "' + m + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
    }
    var ge = {
        exports: {}
    }, ie = {
        exports: {}
    };
    const Ue = {}, xe = Object.freeze(Object.defineProperty({
        __proto__: null,
        default: Ue
    }, Symbol.toStringTag, {
        value: "Module"
    })), ae = _e(xe);
    var me;
    Le = function() {
        return me || (me = 1, function(m) {
            var e = typeof self < "u" && typeof self.Module < "u" ? self.Module : {}, c = {}, s;
            for(s in e)e.hasOwnProperty(s) && (c[s] = e[s]);
            var l = !1, u = !1, R = !1, J = !1;
            l = typeof window == "object", u = typeof importScripts == "function", R = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string", J = !l && !R && !u;
            var g = "";
            function C(n) {
                return e.locateFile ? e.locateFile(n, g) : g + n;
            }
            var T, P, N, k, V;
            R ? (u ? g = ae.dirname(g) + "/" : g = __dirname + "/", T = function(t, a) {
                return k || (k = ae), V || (V = ae), t = V.normalize(t), k.readFileSync(t, a ? null : "utf8");
            }, N = function(t) {
                var a = T(t, !0);
                return a.buffer || (a = new Uint8Array(a)), B(a.buffer), a;
            }, process.argv.length > 1 && process.argv[1].replace(/\\/g, "/"), process.argv.slice(2), m.exports = e, process.on("uncaughtException", function(n) {
                if (!(n instanceof Se)) throw n;
            }), process.on("unhandledRejection", Y), e.inspect = function() {
                return "[Emscripten Module object]";
            }) : J ? (typeof read < "u" && (T = function(t) {
                return read(t);
            }), N = function(t) {
                var a;
                return typeof readbuffer == "function" ? new Uint8Array(readbuffer(t)) : (a = read(t, "binary"), B(typeof a == "object"), a);
            }, typeof scriptArgs < "u" && scriptArgs, typeof print < "u" && (typeof console > "u" && (console = {}), console.log = print, console.warn = console.error = typeof printErr < "u" ? printErr : print)) : (l || u) && (u ? g = self.location.href : typeof document < "u" && document.currentScript && (g = document.currentScript.src), g.indexOf("blob:") !== 0 ? g = g.substr(0, g.lastIndexOf("/") + 1) : g = "", T = function(n) {
                var t = new XMLHttpRequest;
                return t.open("GET", n, !1), t.send(null), t.responseText;
            }, u && (N = function(n) {
                var t = new XMLHttpRequest;
                return t.open("GET", n, !1), t.responseType = "arraybuffer", t.send(null), new Uint8Array(t.response);
            }), P = function(n, t, a) {
                var y = new XMLHttpRequest;
                y.open("GET", n, !0), y.responseType = "arraybuffer", y.onload = function() {
                    if (y.status == 200 || y.status == 0 && y.response) {
                        t(y.response);
                        return;
                    }
                    a();
                }, y.onerror = a, y.send(null);
            }), e.print || console.log.bind(console);
            var r = e.printErr || console.warn.bind(console);
            for(s in c)c.hasOwnProperty(s) && (e[s] = c[s]);
            c = null, e.arguments && e.arguments, e.thisProgram && e.thisProgram, e.quit && e.quit;
            var i;
            e.wasmBinary && (i = e.wasmBinary), e.noExitRuntime, typeof WebAssembly != "object" && Y("no native wasm support detected");
            var o, d = !1;
            function B(n, t) {
                n || Y("Assertion failed: " + t);
            }
            var j = 0, I = 1;
            function z(n, t) {
                var a;
                return t == I ? a = le(n.length) : a = ue(n.length), n.subarray || n.slice ? _.set(n, a) : _.set(new Uint8Array(n), a), a;
            }
            var F = typeof TextDecoder < "u" ? new TextDecoder("utf8") : void 0;
            function q(n, t, a) {
                for(var y = t + a, v = t; n[v] && !(v >= y);)++v;
                if (v - t > 16 && n.subarray && F) return F.decode(n.subarray(t, v));
                for(var S = ""; t < v;){
                    var f = n[t++];
                    if (!(f & 128)) {
                        S += String.fromCharCode(f);
                        continue;
                    }
                    var b = n[t++] & 63;
                    if ((f & 224) == 192) {
                        S += String.fromCharCode((f & 31) << 6 | b);
                        continue;
                    }
                    var W = n[t++] & 63;
                    if ((f & 240) == 224 ? f = (f & 15) << 12 | b << 6 | W : f = (f & 7) << 18 | b << 12 | W << 6 | n[t++] & 63, f < 65536) S += String.fromCharCode(f);
                    else {
                        var de = f - 65536;
                        S += String.fromCharCode(55296 | de >> 10, 56320 | de & 1023);
                    }
                }
                return S;
            }
            function M(n, t) {
                return n ? q(_, n, t) : "";
            }
            function O(n, t) {
                return n % t > 0 && (n += t - n % t), n;
            }
            var h, _;
            function U(n) {
                h = n, e.HEAP8 = new Int8Array(n), e.HEAP16 = new Int16Array(n), e.HEAP32 = new Int32Array(n), e.HEAPU8 = _ = new Uint8Array(n), e.HEAPU16 = new Uint16Array(n), e.HEAPU32 = new Uint32Array(n), e.HEAPF32 = new Float32Array(n), e.HEAPF64 = new Float64Array(n);
            }
            e.INITIAL_MEMORY;
            var p, Q = [], D = [], X = [];
            function Z() {
                if (e.preRun) for(typeof e.preRun == "function" && (e.preRun = [
                    e.preRun
                ]); e.preRun.length;)$(e.preRun.shift());
                re(Q);
            }
            function te() {
                re(D);
            }
            function x() {
                if (e.postRun) for(typeof e.postRun == "function" && (e.postRun = [
                    e.postRun
                ]); e.postRun.length;)L(e.postRun.shift());
                re(X);
            }
            function $(n) {
                Q.unshift(n);
            }
            function G(n) {
                D.unshift(n);
            }
            function L(n) {
                X.unshift(n);
            }
            var E = 0, H = null;
            function K(n) {
                E++, e.monitorRunDependencies && e.monitorRunDependencies(E);
            }
            function ee(n) {
                if (E--, e.monitorRunDependencies && e.monitorRunDependencies(E), E == 0 && H) {
                    var t = H;
                    H = null, t();
                }
            }
            e.preloadedImages = {}, e.preloadedAudios = {};
            function Y(n) {
                e.onAbort && e.onAbort(n), n += "", r(n), d = !0, n = "abort(" + n + "). Build with -s ASSERTIONS=1 for more info.";
                var t = new WebAssembly.RuntimeError(n);
                throw t;
            }
            var Ae = "data:application/octet-stream;base64,";
            function se(n) {
                return n.startsWith(Ae);
            }
            function fe(n) {
                return n.startsWith("file://");
            }
            var A = "argon2.wasm";
            se(A) || (A = C(A));
            function ce(n) {
                try {
                    if (n == A && i) return new Uint8Array(i);
                    if (N) return N(n);
                    throw "both async and sync fetching of the wasm failed";
                } catch (t) {
                    Y(t);
                }
            }
            function ve() {
                if (!i && (l || u)) {
                    if (typeof fetch == "function" && !fe(A)) return fetch(A, {
                        credentials: "same-origin"
                    }).then(function(n) {
                        if (!n.ok) throw "failed to load wasm binary file at '" + A + "'";
                        return n.arrayBuffer();
                    }).catch(function() {
                        return ce(A);
                    });
                    if (P) return new Promise(function(n, t) {
                        P(A, function(a) {
                            n(new Uint8Array(a));
                        }, t);
                    });
                }
                return Promise.resolve().then(function() {
                    return ce(A);
                });
            }
            function we() {
                var n = {
                    a: Te
                };
                function t(f, b) {
                    var W = f.exports;
                    e.asm = W, o = e.asm.c, U(o.buffer), p = e.asm.k, G(e.asm.d), ee();
                }
                K();
                function a(f) {
                    t(f.instance);
                }
                function y(f) {
                    return ve().then(function(b) {
                        var W = WebAssembly.instantiate(b, n);
                        return W;
                    }).then(f, function(b) {
                        r("failed to asynchronously prepare wasm: " + b), Y(b);
                    });
                }
                function v() {
                    return !i && typeof WebAssembly.instantiateStreaming == "function" && !se(A) && !fe(A) && typeof fetch == "function" ? fetch(A, {
                        credentials: "same-origin"
                    }).then(function(f) {
                        var b = WebAssembly.instantiateStreaming(f, n);
                        return b.then(a, function(W) {
                            return r("wasm streaming compile failed: " + W), r("falling back to ArrayBuffer instantiation"), y(a);
                        });
                    }) : y(a);
                }
                if (e.instantiateWasm) try {
                    var S = e.instantiateWasm(n, t);
                    return S;
                } catch (f) {
                    return r("Module.instantiateWasm callback failed with error: " + f), !1;
                }
                return v(), {};
            }
            function re(n) {
                for(; n.length > 0;){
                    var t = n.shift();
                    if (typeof t == "function") {
                        t(e);
                        continue;
                    }
                    var a = t.func;
                    typeof a == "number" ? t.arg === void 0 ? p.get(a)() : p.get(a)(t.arg) : a(t.arg === void 0 ? null : t.arg);
                }
            }
            function be(n, t, a) {
                _.copyWithin(n, t, t + a);
            }
            function Re(n) {
                try {
                    return o.grow(n - h.byteLength + 65535 >>> 16), U(o.buffer), 1;
                } catch  {}
            }
            function Ee(n) {
                var t = _.length;
                n = n >>> 0;
                var a = 2147418112;
                if (n > a) return !1;
                for(var y = 1; y <= 4; y *= 2){
                    var v = t * (1 + .2 / y);
                    v = Math.min(v, n + 100663296);
                    var S = Math.min(a, O(Math.max(n, v), 65536)), f = Re(S);
                    if (f) return !0;
                }
                return !1;
            }
            var Te = {
                a: be,
                b: Ee
            };
            we(), e.___wasm_call_ctors = function() {
                return (e.___wasm_call_ctors = e.asm.d).apply(null, arguments);
            }, e._argon2_hash = function() {
                return (e._argon2_hash = e.asm.e).apply(null, arguments);
            };
            var ue = e._malloc = function() {
                return (ue = e._malloc = e.asm.f).apply(null, arguments);
            };
            e._free = function() {
                return (e._free = e.asm.g).apply(null, arguments);
            }, e._argon2_verify = function() {
                return (e._argon2_verify = e.asm.h).apply(null, arguments);
            }, e._argon2_error_message = function() {
                return (e._argon2_error_message = e.asm.i).apply(null, arguments);
            }, e._argon2_encodedlen = function() {
                return (e._argon2_encodedlen = e.asm.j).apply(null, arguments);
            }, e._argon2_hash_ext = function() {
                return (e._argon2_hash_ext = e.asm.l).apply(null, arguments);
            }, e._argon2_verify_ext = function() {
                return (e._argon2_verify_ext = e.asm.m).apply(null, arguments);
            };
            var le = e.stackAlloc = function() {
                return (le = e.stackAlloc = e.asm.n).apply(null, arguments);
            };
            e.allocate = z, e.UTF8ToString = M, e.ALLOC_NORMAL = j;
            var ne;
            function Se(n) {
                this.name = "ExitStatus", this.message = "Program terminated with exit(" + n + ")", this.status = n;
            }
            H = function n() {
                ne || oe(), ne || (H = n);
            };
            function oe(n) {
                if (E > 0 || (Z(), E > 0)) return;
                function t() {
                    ne || (ne = !0, e.calledRun = !0, !d && (te(), e.onRuntimeInitialized && e.onRuntimeInitialized(), x()));
                }
                e.setStatus ? (e.setStatus("Running..."), setTimeout(function() {
                    setTimeout(function() {
                        e.setStatus("");
                    }, 1), t();
                }, 1)) : t();
            }
            if (e.run = oe, e.preInit) for(typeof e.preInit == "function" && (e.preInit = [
                e.preInit
            ]); e.preInit.length > 0;)e.preInit.pop()();
            oe(), m.exports = e, e.unloadRuntime = function() {
                typeof self < "u" && delete self.Module, e = o = p = h = _ = void 0, delete m.exports;
            };
        }(ie)), ie.exports;
    };
    const We = "/assets/argon2-BUCifEKR.wasm", Ce = async (m = {}, e)=>{
        let c;
        if (e.startsWith("data:")) {
            const s = e.replace(/^data:.*?base64,/, "");
            let l;
            if (typeof Buffer == "function" && typeof Buffer.from == "function") l = Buffer.from(s, "base64");
            else if (typeof atob == "function") {
                const u = atob(s);
                l = new Uint8Array(u.length);
                for(let R = 0; R < u.length; R++)l[R] = u.charCodeAt(R);
            } else throw new Error("Cannot decode base64-encoded data URL");
            c = await WebAssembly.instantiate(l, m);
        } else {
            const s = await fetch(e), l = s.headers.get("Content-Type") || "";
            if ("instantiateStreaming" in WebAssembly && l.startsWith("application/wasm")) c = await WebAssembly.instantiateStreaming(s, m);
            else {
                const u = await s.arrayBuffer();
                c = await WebAssembly.instantiate(u, m);
            }
        }
        return c.instance.exports;
    };
    URL = globalThis.URL;
    const w = await Ce({
        a: {
            a: ye.a,
            b: ye.b
        }
    }, We), Ne = w.c, je = w.d, Fe = w.e, Me = w.f, De = w.g, He = w.h, qe = w.i, $e = w.j, Ge = w.k, Ke = w.l, ke = w.m, Ve = w.n, ze = Object.freeze(Object.defineProperty({
        __proto__: null,
        c: Ne,
        d: je,
        e: Fe,
        f: Me,
        g: De,
        h: He,
        i: qe,
        j: $e,
        k: Ge,
        l: Ke,
        m: ke,
        n: Ve
    }, Symbol.toStringTag, {
        value: "Module"
    })), Xe = _e(ze);
    (function(m) {
        (function(e, c) {
            m.exports ? m.exports = c() : e.argon2 = c();
        })(typeof self < "u" ? self : Be, function() {
            const e = typeof self < "u" ? self : this, c = {
                Argon2d: 0,
                Argon2i: 1,
                Argon2id: 2
            };
            function s(r) {
                if (s._promise) return s._promise;
                if (s._module) return Promise.resolve(s._module);
                let i;
                return e.process && e.process.versions && e.process.versions.node ? i = u().then((o)=>new Promise((d)=>{
                        o.postRun = ()=>d(o);
                    })) : i = R().then((o)=>{
                    const d = r ? g(r) : void 0;
                    return l(o, d);
                }), s._promise = i, i.then((o)=>(s._module = o, delete s._promise, o));
            }
            function l(r, i) {
                return new Promise((o)=>(e.Module = {
                        wasmBinary: r,
                        wasmMemory: i,
                        postRun () {
                            o(Module);
                        }
                    }, u()));
            }
            function u() {
                return e.loadArgon2WasmModule ? e.loadArgon2WasmModule() : typeof pe == "function" ? Promise.resolve(Le()) : Ie(()=>import("./argon2-BzsZV6pE.js").then(async (m)=>{
                        await m.__tla;
                        return m;
                    }).then((r)=>r.a), __vite__mapDeps([0,1,2]));
            }
            function R() {
                if (e.loadArgon2WasmBinary) return e.loadArgon2WasmBinary();
                if (typeof pe == "function") return Promise.resolve(Xe).then((i)=>J(i));
                const r = e.argon2WasmPath || "node_modules/argon2-browser/dist/argon2.wasm";
                return fetch(r).then((i)=>i.arrayBuffer()).then((i)=>new Uint8Array(i));
            }
            function J(r) {
                const i = atob(r), o = new Uint8Array(new ArrayBuffer(i.length));
                for(let d = 0; d < i.length; d++)o[d] = i.charCodeAt(d);
                return o;
            }
            function g(r) {
                const I = Math.min(Math.max(Math.ceil(r * 1024 / 65536), 256) + 256, 32767);
                return new WebAssembly.Memory({
                    initial: I,
                    maximum: 32767
                });
            }
            function C(r, i) {
                return r.allocate(i, "i8", r.ALLOC_NORMAL);
            }
            function T(r, i) {
                const o = new Uint8Array([
                    ...i,
                    0
                ]);
                return C(r, o);
            }
            function P(r) {
                if (typeof r != "string") return r;
                if (typeof TextEncoder == "function") return new TextEncoder().encode(r);
                if (typeof Buffer == "function") return Buffer.from(r);
                throw new Error("Don't know how to encode UTF8");
            }
            function N(r) {
                const i = r.mem || 1024;
                return s(i).then((o)=>{
                    const d = r.time || 1, B = r.parallelism || 1, j = P(r.pass), I = T(o, j), z = j.length, F = P(r.salt), q = T(o, F), M = F.length, O = r.type || c.Argon2d, h = o.allocate(new Array(r.hashLen || 24), "i8", o.ALLOC_NORMAL), _ = r.secret ? C(o, r.secret) : 0, U = r.secret ? r.secret.byteLength : 0, p = r.ad ? C(o, r.ad) : 0, Q = r.ad ? r.ad.byteLength : 0, D = r.hashLen || 24, X = o._argon2_encodedlen(d, i, B, M, D, O), Z = o.allocate(new Array(X + 1), "i8", o.ALLOC_NORMAL), te = 19;
                    let x, $;
                    try {
                        $ = o._argon2_hash_ext(d, i, B, I, z, q, M, h, D, Z, X, O, _, U, p, Q, te);
                    } catch (L) {
                        x = L;
                    }
                    let G;
                    if ($ === 0 && !x) {
                        let L = "";
                        const E = new Uint8Array(D);
                        for(let K = 0; K < D; K++){
                            const ee = o.HEAP8[h + K];
                            E[K] = ee, L += ("0" + (255 & ee).toString(16)).slice(-2);
                        }
                        const H = o.UTF8ToString(Z);
                        G = {
                            hash: E,
                            hashHex: L,
                            encoded: H
                        };
                    } else {
                        try {
                            x || (x = o.UTF8ToString(o._argon2_error_message($)));
                        } catch  {}
                        G = {
                            message: x,
                            code: $
                        };
                    }
                    try {
                        o._free(I), o._free(q), o._free(h), o._free(Z), p && o._free(p), _ && o._free(_);
                    } catch  {}
                    if (x) throw G;
                    return G;
                });
            }
            function k(r) {
                return s().then((i)=>{
                    const o = P(r.pass), d = T(i, o), B = o.length, j = r.secret ? C(i, r.secret) : 0, I = r.secret ? r.secret.byteLength : 0, z = r.ad ? C(i, r.ad) : 0, F = r.ad ? r.ad.byteLength : 0, q = P(r.encoded), M = T(i, q);
                    let O = r.type;
                    if (O === void 0) {
                        let p = r.encoded.split("$")[1];
                        p && (p = p.replace("a", "A"), O = c[p] || c.Argon2d);
                    }
                    let h, _;
                    try {
                        _ = i._argon2_verify_ext(M, d, B, j, I, z, F, O);
                    } catch (p) {
                        h = p;
                    }
                    let U;
                    if (_ || h) {
                        try {
                            h || (h = i.UTF8ToString(i._argon2_error_message(_)));
                        } catch  {}
                        U = {
                            message: h,
                            code: _
                        };
                    }
                    try {
                        i._free(d), i._free(M);
                    } catch  {}
                    if (h) throw U;
                    return U;
                });
            }
            function V() {
                s._module && (s._module.unloadRuntime(), delete s._promise, delete s._module);
            }
            return {
                ArgonType: c,
                hash: N,
                verify: k,
                unloadRuntime: V
            };
        });
    })(ge);
    var he = ge.exports;
    let Ze;
    Ze = Pe(he);
    Je = Oe({
        __proto__: null,
        default: Ze
    }, [
        he
    ]);
});
export { Je as a, Le as r, __tla };
