import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ResolveHub — Support workspace', template: '%s · ResolveHub' },
  description:
    'A thoughtful workspace for tickets, trusted knowledge, and human-reviewed AI support.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
