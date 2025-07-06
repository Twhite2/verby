module.exports = {
  devServer: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
      // WebSocket proxy disabled - connecting directly from client
      // '/ws': {
      //   target: 'http://localhost:3000',
      //   ws: true,
      //   changeOrigin: true
      // }
    }
  },
  configureWebpack: {
    devtool: 'source-map'
  }
}
