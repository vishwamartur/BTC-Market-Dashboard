'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { 
  parseBinanceLiquidationEvent, 
  parseBybitLiquidationEvent,
  parseOkxLiquidationEvent,
  type LiquidationEvent, 
  type LongShortRatio, 
  type OpenInterestData, 
  type TopTraderRatio 
} from '../lib/exchanges';

const MAX_EVENTS = 200;
const SLOW_POLL = 15000;  // 15s — ratios + OI (rate-limit friendly)

export interface LiquidationStats {
  totalLongLiquidations: number;
  totalShortLiquidations: number;
  totalLongUsd: number;
  totalShortUsd: number;
  largestLiquidation: LiquidationEvent | null;
}

export interface ChartDataPoint {
  time: string;
  longUsd: number;
  shortUsd: number;
}

export function useLiquidationData() {
  const [events, setEvents] = useState<LiquidationEvent[]>([]);
  const [stats, setStats] = useState<LiquidationStats>({
    totalLongLiquidations: 0,
    totalShortLiquidations: 0,
    totalLongUsd: 0,
    totalShortUsd: 0,
    largestLiquidation: null,
  });
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const chartBucketRef = useRef<Map<string, { longUsd: number; shortUsd: number }>>(new Map());

  const [longShortRatio, setLongShortRatio] = useState<LongShortRatio | null>(null);
  const [openInterest, setOpenInterest] = useState<OpenInterestData | null>(null);
  const [topTraderRatio, setTopTraderRatio] = useState<TopTraderRatio | null>(null);
  const [ticker, setTicker] = useState<{
    lastPrice: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    volume: string;
    quoteVolume: string;
  } | null>(null);

  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [wsStatus, setWsStatus] = useState<Record<string, boolean>>({});
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [fundingRate, setFundingRate] = useState<number | null>(null);

  // Track price and OI history for the signal engine
  const priceHistoryRef = useRef<number[]>([]);
  const oiHistoryRef = useRef<number[]>([]);
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [oiHistory, setOiHistory] = useState<number[]>([]);

  // Poll REST APIs for market data (OI, ratios, etc.)
  useEffect(() => {
    let active = true;
    const fetchMarketData = async () => {
      if (!active) return;
      try {
        const res = await fetch('/api/market');
        if (!res.ok) return;
        const data = await res.json();

        if (data.ticker) setTicker(data.ticker);
        if (data.longShortRatio) setLongShortRatio(data.longShortRatio);
        if (data.openInterest) {
          setOpenInterest(data.openInterest);
          // Track OI history
          const oiVal = parseFloat(data.openInterest.openInterest);
          if (!isNaN(oiVal) && oiVal > 0) {
            oiHistoryRef.current.push(oiVal);
            if (oiHistoryRef.current.length > 50) oiHistoryRef.current.shift();
            setOiHistory([...oiHistoryRef.current]);
          }
        }
        if (data.topTraderRatio) setTopTraderRatio(data.topTraderRatio);
        if (data.fundingRate && data.fundingRate.fundingRate) {
          setFundingRate(parseFloat(data.fundingRate.fundingRate));
        }

      } catch (err) {
        console.error('Market data fetch error:', err);
      }
    };

    fetchMarketData();
    const interval = setInterval(fetchMarketData, SLOW_POLL);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Seed historical liquidations from MongoDB on mount
  useEffect(() => {
    const seedFromDb = async () => {
      try {
        const res = await fetch('/api/liquidations?limit=200');
        if (!res.ok) return;
        const data = await res.json();

        if (data.events && data.events.length > 0) {
          setEvents(data.events);

          // Rebuild stats from historical data
          const newStats: LiquidationStats = {
            totalLongLiquidations: 0,
            totalShortLiquidations: 0,
            totalLongUsd: 0,
            totalShortUsd: 0,
            largestLiquidation: null,
          };

          for (const event of data.events) {
            const isLong = event.side === 'SELL';
            if (isLong) {
              newStats.totalLongLiquidations++;
              newStats.totalLongUsd += event.usdValue;
            } else {
              newStats.totalShortLiquidations++;
              newStats.totalShortUsd += event.usdValue;
            }
            if (!newStats.largestLiquidation || event.usdValue > newStats.largestLiquidation.usdValue) {
              newStats.largestLiquidation = event;
            }

            // Rebuild chart buckets
            const minuteKey = new Date(event.orderTradeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const bucket = chartBucketRef.current.get(minuteKey) || { longUsd: 0, shortUsd: 0 };
            if (isLong) {
              bucket.longUsd += event.usdValue;
            } else {
              bucket.shortUsd += event.usdValue;
            }
            chartBucketRef.current.set(minuteKey, bucket);
          }

          setStats(newStats);

          // Keep only last 30 buckets
          const entries = Array.from(chartBucketRef.current.entries());
          if (entries.length > 30) {
            const toRemove = entries.slice(0, entries.length - 30);
            for (const [key] of toRemove) {
              chartBucketRef.current.delete(key);
            }
          }

          setChartData(
            Array.from(chartBucketRef.current.entries()).map(([time, d]) => ({
              time,
              longUsd: d.longUsd,
              shortUsd: d.shortUsd,
            }))
          );

          setLastUpdate(Date.now());
        }
      } catch (err) {
        console.error('Failed to seed historical liquidations:', err);
      }
    };

    seedFromDb();
  }, []);

  // Connect to SSE stream for live liquidations and price
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    const connect = () => {
      es = new EventSource('/api/stream');

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'status') {
            setWsStatus(s => ({
              ...s,
              [msg.stream]: msg.connected
            }));
          } else if (msg.type === 'price') {
            setWsStatus(s => s.price ? s : { ...s, price: true });
            const raw = msg.data;
            if (raw.p) {
              const newPrice = parseFloat(raw.p);
              setPrice((prev) => {
                if (prev !== newPrice) setPrevPrice(prev);
                // Track price history for signal engine
                priceHistoryRef.current.push(newPrice);
                if (priceHistoryRef.current.length > 50) priceHistoryRef.current.shift();
                setPriceHistory([...priceHistoryRef.current]);
                return newPrice;
              });
              setLastUpdate(Date.now());
            }
          } else if (msg.type === 'liquidation') {
            const source = msg.source;
            if (source) {
              setWsStatus(s => s[`${source}-liq`] ? s : { ...s, [`${source}-liq`]: true });
            }
            const raw = msg.data;
            let liqEvents: LiquidationEvent[] = [];

            if (source === 'binance') {
              liqEvents = [parseBinanceLiquidationEvent(raw)];
            } else if (source === 'bybit') {
              liqEvents = [parseBybitLiquidationEvent(raw)];
            } else if (source === 'okx') {
              liqEvents = parseOkxLiquidationEvent(raw);
            }

            if (liqEvents.length === 0) return;

            setEvents((prev) => {
              const updated = [...liqEvents, ...prev];
              return updated.slice(0, MAX_EVENTS);
            });

            setStats((prev) => {
              const newStats = { ...prev };
              
              for (const liqEvent of liqEvents) {
                const isLong = liqEvent.side === 'SELL';
                if (isLong) {
                  newStats.totalLongLiquidations++;
                  newStats.totalLongUsd += liqEvent.usdValue;
                } else {
                  newStats.totalShortLiquidations++;
                  newStats.totalShortUsd += liqEvent.usdValue;
                }
                if (!newStats.largestLiquidation || liqEvent.usdValue > newStats.largestLiquidation.usdValue) {
                  newStats.largestLiquidation = liqEvent;
                }

                // Update chart data
                const minuteKey = new Date(liqEvent.orderTradeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const bucket = chartBucketRef.current.get(minuteKey) || { longUsd: 0, shortUsd: 0 };
                
                if (isLong) {
                  bucket.longUsd += liqEvent.usdValue;
                } else {
                  bucket.shortUsd += liqEvent.usdValue;
                }
                chartBucketRef.current.set(minuteKey, bucket);
              }
              
              return newStats;
            });

            // Keep only last 30 buckets
            const entries = Array.from(chartBucketRef.current.entries());
            if (entries.length > 30) {
              chartBucketRef.current.delete(entries[0][0]);
            }

            setChartData(
              Array.from(chartBucketRef.current.entries()).map(([time, data]) => ({
                time,
                longUsd: data.longUsd,
                shortUsd: data.shortUsd,
              }))
            );
            
            setLastUpdate(Date.now());
          }
        } catch (err) {
          // ignore parsing errors
        }
      };

      es.onerror = () => {
        setWsStatus({});
        es?.close();
        reconnectTimeout = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      if (es) {
        es.close();
      }
    };
  }, []);

  return {
    events,
    stats,
    chartData,
    longShortRatio,
    openInterest,
    topTraderRatio,
    ticker,
    price,
    prevPrice,
    wsStatus,
    lastUpdate,
    fundingRate,
    priceHistory,
    oiHistory,
  };
}
