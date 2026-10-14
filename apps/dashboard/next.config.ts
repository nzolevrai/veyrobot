import type { NextConfig } from 'next';
const isDevelopment = process.env.NODE_ENV === 'development';
const scriptSrc = `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`;
const config: NextConfig = {
  async redirects() { return [
    { source: '/profil', destination: '/dashboard/user/profil', permanent: false },
    { source: '/dashboard/user/profile', destination: '/dashboard/user/profil', permanent: false },
  ]; },
  async rewrites() { return [{ source: '/api/:path*', destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/:path*` }]; },
  async headers() { return [{ source: '/:path*', headers: [
    { key: 'Content-Security-Policy', value: `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; font-src 'self' data:; connect-src 'self'; form-action 'self' https://discord.com; base-uri 'self'; frame-ancestors 'none'` },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
  ] }]; },
};
export default config;
