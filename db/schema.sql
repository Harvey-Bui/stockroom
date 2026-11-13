-- Stockroom schema (Postgres). Safe to run repeatedly.
-- Rule: anything the source data doesn't record is NULL, never a guess.

CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id   text PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  contact_name  text,
  phone         text,
  email         text,
  address       text,
  notes         text
);

CREATE TABLE IF NOT EXISTS ingredients (
  ingredient_id    text PRIMARY KEY,
  name             text NOT NULL,
  category         text NOT NULL,
  is_food          boolean NOT NULL DEFAULT true,
  supplier_id      text REFERENCES suppliers(supplier_id),
  supplier_sku     text,
  pack_size        text,
  order_unit       text,
  stock_unit       text,
  min_stock_level  numeric,
  reorder_point    numeric,
  target_stock     numeric,
  shelf_life_days  integer,
  notes            text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id            serial PRIMARY KEY,
  supplier_id      text NOT NULL REFERENCES suppliers(supplier_id),
  invoice_number   text,
  invoice_date     date NOT NULL,
  delivery_date    date,
  delivery_status  text NOT NULL DEFAULT 'delivered'
                   CHECK (delivery_status IN ('ordered','delivered','partial','cancelled'))
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  line_id              serial PRIMARY KEY,
  po_id                integer NOT NULL REFERENCES purchase_orders(po_id),
  ingredient_id        text NOT NULL REFERENCES ingredients(ingredient_id),
  invoice_description  text,
  qty_ordered          numeric NOT NULL,
  qty_shipped          numeric NOT NULL,
  unit                 text,
  unit_cost_usd        numeric,
  line_cost_usd        numeric,
  notes                text
);

CREATE TABLE IF NOT EXISTS stock_lots (
  lot_id            serial PRIMARY KEY,
  ingredient_id     text NOT NULL REFERENCES ingredients(ingredient_id),
  purchase_line_id  integer REFERENCES purchase_lines(line_id),
  received_date     date NOT NULL,
  quantity          numeric NOT NULL,
  unit              text,
  expiration_date   date,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','discarded'))
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  txn_id            serial PRIMARY KEY,
  ingredient_id     text NOT NULL REFERENCES ingredients(ingredient_id),
  txn_type          text NOT NULL CHECK (txn_type IN ('receipt','usage','waste','count','adjustment')),
  quantity          numeric NOT NULL,
  unit              text,
  txn_at            timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by       text,
  purchase_line_id  integer REFERENCES purchase_lines(line_id),
  note              text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        serial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_name text,
  role      text,
  action    text NOT NULL,
  details   jsonb NOT NULL,
  outcome   text NOT NULL CHECK (outcome IN ('applied','declined','rejected','expired'))
);

-- App plumbing (never exposed to the assistant's read connection)
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY,
  user_name   text NOT NULL,
  role        text NOT NULL,
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_name        text NOT NULL,
  role             text NOT NULL,
  action           text NOT NULL,
  args             jsonb NOT NULL,
  summary          text NOT NULL,
  tool_use_id      text NOT NULL,
  other_results    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','declined','expired')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_txn_ing_time ON inventory_transactions (ingredient_id, txn_at);
CREATE INDEX IF NOT EXISTS ix_lines_ing    ON purchase_lines (ingredient_id);
CREATE INDEX IF NOT EXISTS ix_lots_exp     ON stock_lots (expiration_date);

-- ---------------------------------------------------------------------------
-- Views (full detail, for managers)
-- ---------------------------------------------------------------------------

-- Current stock = last physical count + receipts/adjustments since − usage/waste since.
-- No count on record → NULL ("Unknown"). Deliveries alone don't say what's on the shelf.
CREATE OR REPLACE VIEW v_current_stock AS
WITH last_count AS (
  SELECT DISTINCT ON (ingredient_id) ingredient_id, quantity AS counted_qty, txn_at AS counted_at
  FROM inventory_transactions WHERE txn_type = 'count'
  ORDER BY ingredient_id, txn_at DESC, txn_id DESC
),
since AS (
  SELECT t.ingredient_id,
         SUM(CASE WHEN t.txn_type IN ('receipt','adjustment') THEN t.quantity
                  WHEN t.txn_type IN ('usage','waste') THEN -t.quantity ELSE 0 END) AS net_change
  FROM inventory_transactions t JOIN last_count c USING (ingredient_id)
  WHERE t.txn_type <> 'count' AND t.txn_at > c.counted_at
  GROUP BY t.ingredient_id
),
calc AS (
  SELECT i.*, c.counted_at,
         CASE WHEN c.counted_qty IS NULL THEN NULL ELSE c.counted_qty + COALESCE(n.net_change, 0) END AS cur
  FROM ingredients i
  LEFT JOIN last_count c USING (ingredient_id)
  LEFT JOIN since n USING (ingredient_id)
)
SELECT k.ingredient_id, k.name, k.category, k.is_food,
       s.name                               AS supplier,
       COALESCE(k.stock_unit, k.order_unit) AS unit,
       k.pack_size,
       k.cur                                AS current_stock,
       k.counted_at                         AS last_counted_at,
       k.min_stock_level, k.reorder_point, k.target_stock,
       CASE
         WHEN k.cur IS NULL THEN 'Unknown - no stock count recorded'
         WHEN COALESCE(k.reorder_point, k.min_stock_level) IS NULL THEN 'Unknown - no threshold set'
         WHEN k.cur <= 0 THEN 'Out of stock'
         WHEN k.min_stock_level IS NOT NULL AND k.cur < k.min_stock_level THEN 'Low stock'
         WHEN k.reorder_point IS NOT NULL AND k.cur <= k.reorder_point THEN 'Reorder'
         ELSE 'OK'
       END AS stock_status,
       k.notes
FROM calc k LEFT JOIN suppliers s USING (supplier_id);

CREATE OR REPLACE VIEW v_purchase_history AS
SELECT pl.line_id, po.po_id, po.invoice_number, po.invoice_date,
       COALESCE(po.delivery_date, po.invoice_date) AS delivery_date,
       (po.delivery_date IS NULL)                  AS delivery_date_is_invoice_date,
       po.delivery_status,
       s.name AS supplier, i.ingredient_id, i.name AS ingredient, i.category,
       pl.invoice_description, i.pack_size,
       pl.qty_ordered, pl.qty_shipped, pl.qty_ordered - pl.qty_shipped AS qty_short,
       pl.unit, pl.unit_cost_usd, pl.line_cost_usd, pl.notes
FROM purchase_lines pl
JOIN purchase_orders po USING (po_id)
JOIN suppliers s ON s.supplier_id = po.supplier_id
JOIN ingredients i ON i.ingredient_id = pl.ingredient_id;

CREATE OR REPLACE VIEW v_expiring_lots AS
SELECT l.lot_id, i.ingredient_id, i.name AS ingredient, l.quantity, l.unit, l.received_date,
       COALESCE(l.expiration_date,
                CASE WHEN i.shelf_life_days IS NOT NULL THEN l.received_date + i.shelf_life_days END) AS expiration_date,
       CASE WHEN l.expiration_date IS NOT NULL THEN 'recorded'
            WHEN i.shelf_life_days IS NOT NULL THEN 'estimated from shelf life'
            ELSE 'unknown' END AS expiration_source,
       l.status
FROM stock_lots l JOIN ingredients i USING (ingredient_id);

-- ---------------------------------------------------------------------------
-- Staff schema: same names, no cost columns. The staff reader login can only see this.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS staff_ro;

CREATE OR REPLACE VIEW staff_ro.suppliers AS SELECT * FROM public.suppliers;
CREATE OR REPLACE VIEW staff_ro.ingredients AS SELECT * FROM public.ingredients;
CREATE OR REPLACE VIEW staff_ro.purchase_orders AS SELECT * FROM public.purchase_orders;
CREATE OR REPLACE VIEW staff_ro.purchase_lines AS
  SELECT line_id, po_id, ingredient_id, invoice_description, qty_ordered, qty_shipped, unit, notes
  FROM public.purchase_lines;
CREATE OR REPLACE VIEW staff_ro.stock_lots AS SELECT * FROM public.stock_lots;
CREATE OR REPLACE VIEW staff_ro.inventory_transactions AS SELECT * FROM public.inventory_transactions;
CREATE OR REPLACE VIEW staff_ro.v_current_stock AS SELECT * FROM public.v_current_stock;
CREATE OR REPLACE VIEW staff_ro.v_expiring_lots AS SELECT * FROM public.v_expiring_lots;
CREATE OR REPLACE VIEW staff_ro.v_purchase_history AS
  SELECT line_id, po_id, invoice_number, invoice_date, delivery_date, delivery_date_is_invoice_date,
         delivery_status, supplier, ingredient_id, ingredient, category, invoice_description, pack_size,
         qty_ordered, qty_shipped, qty_short, unit, notes
  FROM public.v_purchase_history;
