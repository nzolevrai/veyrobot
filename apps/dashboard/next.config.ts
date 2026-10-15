import type { NextConfig } from 'next';

const config: NextConfig = {
  async redirects() {
    return [
      { source: '/profil', destination: '/dashboard/user/profil', permanent: false },
      { source: '/dashboard/user/profile', destination: '/dashboard/user/profil', permanent: false },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] }];
  },
};

export default config;
