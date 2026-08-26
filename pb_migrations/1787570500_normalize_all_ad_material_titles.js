/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const records = app.findRecordsByFilter("ad_materials", "platform = 'DataEye ADX'", "id", 100000, 0).filter(Boolean);
  const groups = {};

  for (const record of records) {
    const title = record.getString("title").trim();
    const ranked = title.match(/^(.*)-(20\d{6})-\d{2,4}$/);
    const legacy = title.match(/^(.*)-(20\d{6})-ADX-[A-Za-z0-9_-]+$/);
    const match = ranked || legacy;
    const base = (match ? match[1] : title).trim();
    const created = record.getString("created");
    const date = match ? match[2] : created.slice(0, 10).replace(/-/g, "");
    if (!base || !/^20\d{6}$/.test(date)) continue;
    const key = `${base}\u0000${date}`;
    if (!groups[key]) groups[key] = { base, date, records: [] };
    groups[key].records.push(record);
  }

  for (const group of Object.values(groups)) {
    group.records.sort((left, right) => {
      const exposureDifference = right.getFloat("exposure") - left.getFloat("exposure");
      return exposureDifference || left.id.localeCompare(right.id);
    });
    group.records.forEach((record, index) => {
      record.set("title", `${group.base}-${group.date}-${String(index + 1).padStart(2, "0")}`);
      app.save(record);
    });
  }
}, () => {
  // Data-only migration: normalized titles are intentionally retained on rollback.
});
