# 15. How an order flows (pickup rider → warehouse → delivery rider)

This is the way the client works, set up after their review of the first demo.

## Who does what

| Person | App | Does |
|---|---|---|
| Customer | Website | Books (price shown first), pays the rider in cash or online, follows the parcel: Booked → Picked up → At warehouse → On the way → Delivered |
| Recipient | Text message | Gets a one-time code when the parcel leaves the warehouse and gives it to the delivery rider |
| Dispatcher | Staff app → **Orders** | Assigns a **pickup rider** to new orders, then a **delivery rider** once the parcel is in the warehouse. Only riders of the right type can be chosen |
| Pickup rider | Rider app | Collects the parcel (scans the label, takes the cash) and brings it to the warehouse |
| Warehouse staff | Staff app → **Warehouse** | *Receive parcel*: scan parcels in from pickup riders (and back from delivery riders who could not deliver). *Give to rider*: scan a parcel out to its assigned delivery rider |
| Delivery rider | Rider app | Collects at the warehouse and delivers with the recipient's code (or a signature and photo) |
| Manager | Staff app → **Today** and everything else | Sees the whole day: new orders, delivered, late or with problems, cash held by riders, where the orders are, riders on shift (busy/free), the warehouse. Downloads the **Excel backup** |
| Finance, fleet, owner | Staff app | As before: rider pay and cash, expenses, invoices, reports; riders and vehicles; staff access and settings |

## Rider accounts

Each rider account is either a **pickup rider** or a **delivery rider** (Staff app → **Riders & vehicles** → *Add a rider*). The type can be changed there later by the fleet manager, dispatcher or manager. The server refuses to assign a delivery rider to a pickup or the other way round. Accounts created before this change have no type and may do both.

## The warehouse

Each area has one warehouse (Staff app → Settings → **Areas & warehouses**; the sample has the Accra Warehouse). Same-city orders in an area with a warehouse always go through it. In an area without a warehouse, one rider takes the parcel door to door.

## Same city only, for now

The sample prices have `"intercity": { "enabled": false }` and `"longDistance": { "enabled": false }`, so the website explains "For now we only deliver within Greater Accra…" when the destination is in another city. The intercity code (hubs, trucks, manifests) is still in the system. To switch it on later, set those to `true` in `firebase/seed/pricing-rules.sample.json`, add the warehouses and routes, and run **Admin tasks → seed-config**. The intercity screens can then be brought back from the git history.

## Excel backup

Staff app → **Excel backup** (manager, finance, admins). Choose This month, Last month, This year, Everything, or your own dates, then **Download Excel file**. The workbook has a sheet each for orders (with both riders), customers, payments, riders, rider cash hand-ins, rider pay, expenses, fuel and shifts. The file contains customers' names and phone numbers, so keep it safe. Every download is recorded in the audit log.
