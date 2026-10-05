// 新应用 lint 门（eslint v9 flat config）。
// 监听面＝src/（Vue SFC + TS）与 scripts/（node 侧 .mjs）。批E 已删除
// rewrite 前的旧结构（modules/、i18n/、根 loader 桩、prompts/、shared/）。
// scripts/check-imports.mjs 与 smoke 相关脚本由本门做基础正确性检查
// （no-undef / 未用变量），语义断言归脚本自身 exit code。
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
    ...tseslint.configs.recommended.map(entry => ({
        ...entry,
        // TS 规则须覆盖 .vue 的 script 块（SFC 由下方 vue-eslint-parser +
        // tseslint.parser 组合解析）——漏掉 .vue 会让 SFC 成为 TS 门盲区
        files: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts', 'scripts/**/*.mjs'],
    })),
    ...pluginVue.configs['flat/recommended'],
    {
        files: ['src/**/*.vue'],
        languageOptions: {
            parserOptions: {
                parser: tseslint.parser,
            },
        },
    },
    {
        files: ['src/**/*.ts', 'src/**/*.vue', 'scripts/**/*.mjs'],
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        languageOptions: {
            globals: {
                ...globals.browser,
                // TT 宿主注入的运行时全局（不 import，只在宿主窗口存在）
                SillyTavern: 'readonly',
                quickReplyApi: 'readonly',
                toastr: 'readonly',
            },
        },
        rules: {
            // 平移代码与宿主边界打交道多，any 边界集中在 host 层收敛；
            // no-explicit-any 保持 error，边界处用显式 unknown + 收窄
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        files: ['scripts/**/*.mjs', 'vite.config.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    {
        // vue/flat/recommended 的模板规则对 SFC 模板生效，脚本块走 TS 规则；
        // 关掉与本仓风格冲突的属性顺序硬规则
        files: ['src/**/*.vue'],
        rules: {
            'vue/attributes-order': 'off',
            'vue/max-attributes-per-line': 'off',
            'vue/singleline-html-element-content-newline': 'off',
            'vue/multiline-html-element-content-newline': 'off',
        },
    },
);
