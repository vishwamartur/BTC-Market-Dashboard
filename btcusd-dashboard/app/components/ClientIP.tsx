'use client';

import { useEffect, useState } from 'react';

export default function ClientIP() {
  const [ip, setIp] = useState<string>('Loading IP...');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // api64.ipify.org will return IPv6 if supported, otherwise IPv4.
    fetch('https://api64.ipify.org?format=json')
      .then(res => res.json())
      .then(data => setIp(data.ip))
      .catch(err => {
        console.error('Failed to fetch IP', err);
        setIp('IP Unavailable');
      });
  }, []);

  const handleCopy = () => {
    if (ip && ip !== 'Loading IP...' && ip !== 'IP Unavailable') {
      navigator.clipboard.writeText(ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div 
      className="connection-status" 
      onClick={handleCopy}
      style={{ 
        cursor: 'pointer', 
        marginLeft: '12px',
        transition: 'all 0.2s ease',
        borderColor: copied ? 'var(--green)' : 'var(--border-color)'
      }}
      title="Click to copy IP for Delta Exchange"
    >
      <span style={{ color: 'var(--text-muted)' }}>IPv6:</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: copied ? 'var(--green)' : 'var(--text-primary)' }}>
        {ip}
      </span>
      {copied && <span style={{ color: 'var(--green)', marginLeft: '4px', fontSize: '11px', fontWeight: 600 }}>Copied!</span>}
    </div>
  );
}
