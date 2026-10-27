'use client';

import { Printer } from 'lucide-react';
import { buttonClass } from '@/components/ui';

export function PrintButton() {
  return (
    <button
      type="button"
      className={buttonClass('primary')}
      onClick={() => {
        window.print();
      }}
    >
      <Printer size={16} aria-hidden="true" /> Print or save as PDF
    </button>
  );
}
