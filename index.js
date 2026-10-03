// tt-toolkit loader —— 模块注册制入口。
// 每模块独立 try/catch：单模块崩溃只 console.error + toast，不拖死其他模块。
// 各模块自管 jQuery 就绪等待（persona 自带 jQuery(async => {...})），
// loader 不做加载顺序假设，仅按注册顺序动态 import。
const MODULES = [
    { id: "persona", load: () => import("./modules/persona/index.js") },
    { id: "choice", load: () => import("./dist/index.js") },
    { id: "nav", load: () => import("./modules/nav/index.js") },
];

function toastFailure(id) {
    try {
        if (typeof toastr !== "undefined" && toastr?.error) toastr.error(`tt-toolkit[${id}] 加载失败`);
    } catch { /* toastr 不可用则仅 console */ }
}

for (const mod of MODULES) {
    try {
        await mod.load();
        console.info(`tt-toolkit[${mod.id}] ready`);
    } catch (err) {
        console.error(`tt-toolkit[${mod.id}] 加载失败`, err);
        toastFailure(mod.id);
    }
}
console.info("tt-toolkit loader ready");
