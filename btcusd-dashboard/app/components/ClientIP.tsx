'use client';

import { useEffect, useState } from 'react';

export default function ClientIP() {
  const [ip, setIp] = useState<string>('Loading Server IP...');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Fetch the deployed server's IP address from our API route
    fetch('/api/server-ip')
      .then(res => res.json())
      .then(data => {
        if (data.ipv4) {
          setIp(data.ipv4);
        } else if (data.ip) {
          setIp(data.ip);
        } else {
          setIp('IP Unavailable');
        }
      })
      .catch(err => {
        console.error('Failed to fetch server IP', err);
        setIp('IP Unavailable');
      });
  }, []);

  const handleCopy = () => {
    if (ip && ip !== 'Loading Server IP...' && ip !== 'IP Unavailable') {
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
      title="Click to copy Server IP for Delta Exchange"
    >
      <span style={{ color: 'var(--text-muted)' }}>Server IPv4:</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: copied ? 'var(--green)' : 'var(--text-primary)' }}>
        {ip}
      </span>
      {copied && <span style={{ color: 'var(--green)', marginLeft: '4px', fontSize: '11px', fontWeight: 600 }}>Copied!</span>}
    </div>
  );
}
