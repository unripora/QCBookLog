import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
// 后端地址：可通过环境变量覆盖
//   - 本地开发（不在容器内）：默认 http://localhost:7401
//   - 容器开发（deploy.sh 启动）：VITE_BACKEND_TARGET=http://qc-booklog-backend:7401
const backendTarget = process.env.VITE_BACKEND_TARGET || process.env.BACKEND_TARGET || 'http://localhost:7401'

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    base: '/',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(process.cwd(), 'src')
      }
    },
    optimizeDeps: {
      // tesseract.js 通过 package.json 的 browser 字段做环境替换：
      //   { "./src/worker/node/index.js": "./src/worker/browser/index.js" }
      // Vite 依赖预构建（esbuild）默认不解析这种「对象映射」形式，
      // 会导致浏览器端误用 Node 版 Worker（worker_threads），
      // 调用 postMessage 时抛出 DataCloneError。
      // 显式纳入预构建并强制 browser platform 可正确替换。
      include: ['tesseract.js'],
      esbuildOptions: {
        platform: 'browser',
        mainFields: ['browser', 'module', 'main']
      }
    },
    server: {
    host: '0.0.0.0', // 允许外部设备访问
    port: 8080, // 修改端口号为 8080
    strictPort: false, // 不强制使用特定端口，如果被占用则自动递增
    allowedHosts: [
      'paxil-maritime-dance-contests.trycloudflare.com',
      '.trycloudflare.com',
      'localhost',
      '127.0.0.1',
      'qcbooklog.voidvoice.ip-ddns.com'
    ],
    fs: {
      // 允许访问项目根目录外的文件
      allow: ['.']
    },
    proxy: {
      // 优先匹配具体的API路径，代理到本地后端
      '/api/douban/cover': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 阿里云OSS图片代理，代理到本地后端
      '/api/aliyun-oss-image': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // DBR API代理，代理到本地后端
      '/api/dbr': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 探数图书API代理，代理到本地后端
      '/api/tanshu': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 豆瓣图书API代理，代理到本地后端
      '/api/douban': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 公共图书API代理，代理到本地后端
      '/api/isbn-work': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 其他书籍相关API，代理到本地后端
      '/api/books': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/api/groups': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/api/tags': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/api/bookmarks': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/api/backup': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 健康检查和版本信息，代理到本地后端
      '/api/health': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/api/version': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 性能监控API，代理到本地后端
      '/api/performance': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // Calibre 配置API，代理到本地后端
      '/api/config': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 阅读追踪API，代理到本地后端
      '/api/reading': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      },
      // 优化后的豆瓣图片代理配置，解决40310015错误
      '/api/douban-cover': {
        target: 'https://img1.doubanio.com',
        changeOrigin: true,
        rewrite: (path) => {
          // 重写路径：/api/douban-cover/s35334340.jpg → /view/subject/l/public/s35334340.jpg
          const coverId = path.split('/').pop()?.replace('.jpg', '') || '';
          return `/view/subject/l/public/${coverId}.jpg`;
        },
        // 核心：模拟豆瓣站内请求的完整请求头
        headers: {
          'Referer': 'https://book.douban.com/',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Dest': 'image',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        }
      },
      // 其他API请求代理到本地后端服务器（通用代理）
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path
      }
    }
  },
  // 把后端地址注入到客户端代码（兼容已有代码使用 import.meta.env 读取）
  define: {
    __BACKEND_TARGET__: JSON.stringify(backendTarget)
  }
}
})
