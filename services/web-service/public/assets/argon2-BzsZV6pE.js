import { a as s, __tla as __tla_0 } from "./index-CEtgWK0C.js";
import { r as g, __tla as __tla_1 } from "./argon2-Rkl4JTia.js";
let l;
let __tla = Promise.all([
    (()=>{
        try {
            return __tla_0;
        } catch  {}
    })(),
    (()=>{
        try {
            return __tla_1;
        } catch  {}
    })()
]).then(async ()=>{
    function i(t, n) {
        for(var o = 0; o < n.length; o++){
            const r = n[o];
            if (typeof r != "string" && !Array.isArray(r)) {
                for(const e in r)if (e !== "default" && !(e in t)) {
                    const a = Object.getOwnPropertyDescriptor(r, e);
                    a && Object.defineProperty(t, e, a.get ? a : {
                        enumerable: !0,
                        get: ()=>r[e]
                    });
                }
            }
        }
        return Object.freeze(Object.defineProperty(t, Symbol.toStringTag, {
            value: "Module"
        }));
    }
    var f = g();
    let c;
    c = s(f);
    l = i({
        __proto__: null,
        default: c
    }, [
        f
    ]);
});
export { l as a, __tla };
