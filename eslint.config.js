// 根 lint 门 flat config（eslint v9）。定位＝抓 no-undef 类 typo 的正确性门
// （批3 nav 裸 CONFIG 常量引用回归的防复发门），非完整工程规范，KISS：
//   - 不引 import 插件——nav 对宿主模块（events.js / slash-commands 等）的
//     逃逸 import 只在 TT 运行时存在，仓内 lint 无从解析，开了只会放行或误报；
//   - 监听面＝loader + nav + shared；dist（上游构建产物）/ i18n（数据）/
//     modules/persona（自带独立 lint 门与 dev kit）不入面。
// globals 按实测 no-undef 报错补全：浏览器 + TT 宿主注入全局。
export default [
    {
        ignores: ["dist/**", "i18n/**", "modules/persona/**", "node_modules/**", "prompts/**"],
    },
    {
        files: ["index.js", "modules/nav/**/*.js", "shared/**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                // 浏览器全局
                window: "readonly",
                document: "readonly",
                localStorage: "readonly",
                navigator: "readonly",
                fetch: "readonly",
                // 平台内置（flat config 不随 ecmaVersion 自动补 host 全局，实测报错补全）
                console: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                MutationObserver: "readonly",
                // TT 宿主注入全局
                SillyTavern: "readonly",
                toastr: "readonly",
            },
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": "warn",
        },
    },
];
