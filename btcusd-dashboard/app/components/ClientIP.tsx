'use client';

import { useEffect, useState } from 'react';

export default function ClientIP() {
  const [ipv4, setIpv4] = useState<string>('Loading...');
  const [ipv6, setIpv6] = useState<string>('');
  const [copied4, setCopied4] = useState(false);
  const [copied6, setCopied6] = useState(false);

  useEffect(() => {
    // Fetch the deployed server's IP addresses from our API route
    fetch('/api/server-ip')
      .then(res => res.json())
      .then(data => {
        setIpv4(data.ipv4 || data.ip || 'IPv4 Unavailable');
        if (data.ipv6 && data.ipv6 !== 'Not Available') {
          setIpv6(data.ipv6);
        }
      })
      .catch(err => {
        console.error('Failed to fetch server IP', err);
        setIpv4('IP Unavailable');
      });
  }, []);

  const handleCopy4 = () => {
    if (ipv4 && ipv4 !== 'Loading...' && ipv4 !== 'IP Unavailable' && ipv4 !== 'IPv4 Unavailable') {
      navigator.clipboard.writeText(ipv4);
      setCopied4(true);
      setTimeout(() => setCopied4(false), 2000);
    }
  };

  const handleCopy6 = () => {
    if (ipv6) {
      navigator.clipboard.writeText(ipv6);
      setCopied6(true);
      setTimeout(() => setCopied6(false), 2000);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '12px' }}>
      <div 
        className="connection-status" 
        onClick={handleCopy4}
        style={{ 
          cursor: 'pointer', 
          transition: 'all 0.2s ease',
          borderColor: copied4 ? 'var(--green)' : 'var(--border-color)'
        }}
        title="Click to copy Server IPv4"
      >
        <span style={{ color: 'var(--text-muted)' }}>IPv4:</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: copied4 ? 'var(--green)' : 'var(--text-primary)' }}>
          {ipv4}
        </span>
        {copied4 && <span style={{ color: 'var(--green)', marginLeft: '4px', fontSize: '11px', fontWeight: 600 }}>Copied!</span>}
      </div>

      {ipv6 && (
        <div 
          className="connection-status" 
          onClick={handleCopy6}
          style={{ 
            cursor: 'pointer', 
            transition: 'all 0.2s ease',
            borderColor: copied6 ? 'var(--green)' : 'var(--border-color)'
          }}
          title="Click to copy Server IPv6"
        >
          <span style={{ color: 'var(--text-muted)' }}>IPv6:</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: copied6 ? 'var(--green)' : 'var(--text-primary)' }}>
            {ipv6}
          </span>
          {copied6 && <span style={{ color: 'var(--green)', marginLeft: '4px', fontSize: '11px', fontWeight: 600 }}>Copied!</span>}
        </div>
      )}
    </div>
  );
}
