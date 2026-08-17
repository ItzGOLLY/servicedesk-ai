/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // One palette, defined once, used everywhere — this is the design system.
        ink: {
          DEFAULT: '#0A2E36',
          light: '#12414C',
          soft: '#1D5361',
        },
        brand: {
          50: '#EAF6F5',
          100: '#D2ECEA',
          200: '#A6D9D6',
          300: '#6FC2BE',
          400: '#2FA79F',
          500: '#028090',
          600: '#016F7D',
          700: '#015765',
          800: '#01414C',
          900: '#012E36',
        },
        sea: '#00A896',
        mint: '#02C39A',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(10, 46, 54, 0.04), 0 4px 12px rgba(10, 46, 54, 0.06)',
        pop: '0 8px 28px rgba(10, 46, 54, 0.14)',
      },
    },
  },
  plugins: [],
};
