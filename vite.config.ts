import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { defineConfig } from 'vite';

// 产物部署位＝TT 扩展树 /scripts/extensions/third-party/tt-toolkit/dist/index.js
// （TauriTavern src/scripts/extensions/runtime/resource-paths.js:10
// getExtensionResourceUrl 的 URL 形态）。@sillytavern/* 说明符在产物里重写为
// 从 dist/ 出发指向酒馆 web 根的相对路径：dist→tt-toolkit→third-party→
// extensions→scripts→根共 5 级。check-imports.mjs 从本文件机读该级数并对
// 产物逐条断言，安装深度变化时改这里即可。
const SILLYTAVERN_UPLEVELS = 5;
const relativeSillytavernPath = '../'.repeat(SILLYTAVERN_UPLEVELS);

export default defineConfig(() => ({
  plugins: [
    vue({
      features: {
        // 统一 Composition API，不留 Options API 双轨
        optionsAPI: false,
      },
    }),
    {
      name: 'sillytavern_resolver',
      enforce: 'pre',
      resolveId(id: string) {
        // 源码统一用无后缀形态（@sillytavern/scripts/events），
        // 酒馆 web 根下的真实文件带 .js——这里补上
        if (id.startsWith('@sillytavern/')) {
          const tail = id.slice('@sillytavern/'.length);
          return {
            id: `${relativeSillytavernPath}${tail}.js`,
            external: true,
          };
        }
        return null;
      },
    },
  ],

  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },

  build: {
    rollupOptions: {
      input: 'src/main.ts',
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        // 单入口（CSS 是唯一 asset）固定名对齐 manifest 声明
        assetFileNames: 'index.css',
        // 动态 import 自动分块（node 冒烟面拆独立 chunk，本配置不开任何分块
        // 开关）：执行面只认 manifest 声明的入口 js（TauriTavern 扩展加载器
        // 只执行 manifest 列出的文件），更新流按提交点整树落盘——附属 chunk
        // 随仓到达用户安装但永不执行，浏览器加载面由入口静态图决定
        chunkFileNames: '[name].chunk.js',
        preserveModules: false,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    // 发布产物不带 map（扩展加载用不到）；本地调试需要时改 mode 再看
    sourcemap: false,
    target: 'esnext',
    minify: 'esbuild',
  },
}));
