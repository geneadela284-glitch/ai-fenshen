export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'PingFang SC', 'Microsoft YaHei', 'sans-serif']
      },
      colors: {
        ink: '#172026',
        muted: '#667085',
        paper: '#f6f7f9',
        line: '#d8dde6',
        brand: '#176b87',
        action: '#d96c2c'
      },
      boxShadow: {
        panel: '0 16px 40px rgba(23, 32, 38, 0.08)'
      }
    }
  },
  plugins: []
};
