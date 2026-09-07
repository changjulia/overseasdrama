/// <reference path="../pb_data/types.d.ts" />

// Each SQLite connection has its own page cache. Small hosts need a bounded
// database pool in addition to Go's heap limit and the JavaScript hook pool.
onBootstrap((e) => {
  e.next();
  const configured = Number($os.getenv("LUMINA_DB_MAX_CONNECTIONS"));
  if (!Number.isInteger(configured) || configured < 2 || configured > 32) return;
  // SQLite uses allocations outside Go's managed heap. GOMEMLIMIT alone
  // cannot bound them. These are process-wide limits, including new connections.
  e.app.db().newQuery("PRAGMA soft_heap_limit=67108864").execute();
  e.app.db().newQuery("PRAGMA hard_heap_limit=268435456").execute();
  const data = e.app.concurrentDB().db();
  data.setMaxOpenConns(configured);
  data.setMaxIdleConns(Math.min(2, configured));
  data.setConnMaxIdleTime(60 * 1000000000);
  const auxiliary = e.app.auxConcurrentDB().db();
  auxiliary.setMaxOpenConns(2);
  auxiliary.setMaxIdleConns(1);
  auxiliary.setConnMaxIdleTime(60 * 1000000000);
  console.log("Lumina database pool limited to", configured, "read connections");
});

