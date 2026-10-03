// lint 门 flat config（eslint v9）。拍板：仅作 lint 门，不引格式化改写（prettier 不装），
// 因此只开正确性规则，不开风格规则。
// 监听面＝index.js + src/**/*.js；diff.min.js（压缩产物）与 scripts/（仓内自洽脚本）不入面。
// globals 按实测 no-undef 报错补全：浏览器 + ST 宿主注入的 $ / toastr / Swal 等。
import importPlugin from "eslint-plugin-import";

export default [
    {
        ignores: ["diff.min.js", "scripts/**", "tests/**"],
    },
    {
        files: ["index.js", "src/**/*.js"],
        plugins: {
            import: importPlugin,
        },
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
                FileReader: "readonly",
                requestAnimationFrame: "readonly",
                confirm: "readonly",
                prompt: "readonly",
                // 平台内置（flat config 不随 ecmaVersion 自动补 host 全局，实测报错补全）
                console: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                AbortController: "readonly",
                TextDecoder: "readonly",
                Image: "readonly",
                FormData: "readonly",
                File: "readonly",
                // ST 宿主 / 插件注入全局
                SillyTavern: "readonly",
                $: "readonly",
                jQuery: "readonly",
                toastr: "readonly",
            },
        },
        rules: {
            "no-undef": "error",
            // ST 宿主模块（extensions.js / script.js / world-info.js / personas.js /
            // power-user.js / utils.js）只在酒馆运行时存在，对该 pattern 关闭解析检查；
            // 仓内相对导入仍受检查。不带 scripts/ 段：上溯 4/5 段已落在宿主 scripts/ 目录内，
            // 多写一段＝scripts/scripts/ 双段解析必炸，此形态必须报错不许放行。
            "import/no-unresolved": ["error", { ignore: ["^(?:\\.\\./)+(?:extensions|script|world-info|personas|power-user|utils)\\.js$"] }],
        },
    },
];
