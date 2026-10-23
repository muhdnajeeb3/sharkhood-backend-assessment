# Provider data factory

Reads the xbyte Talabat export from a raw Mongo database, and writes a normalised model to a second database. NestJS, the Mongo driver, BullMQ.

The shape of the data and the reasons for the collections are in [ARCHITECTURE.md](ARCHITECTURE.md). That is the document to read first.

## What a run produces

From the sample (8 location snapshots, 70 listing pages, 500 menu fetches):

- 697 locations. Slugs are not unique; ids are.
- One restaurant per public outlet id. Listings and menus both upsert it. A listing cannot overwrite a menu profile.
- A service-area row per outlet and area. 161 outlets in the sample are listed in two areas.
- Categories, items, and placements. An item that sits in two sections is stored once.
- A quarantine row for the 155 "not a restaurant page" menus, the two empty listing pages, and any row whose URL has no outlet id.

Running it twice does not create a second copy and does not change a field.

## Run it

Docker and Node 22 or newer.

```bash
cp .env.example .env
docker compose up -d mongo redis
npm install
npm run seed
npm run start:dev
```

Seed loads `data/raw/*.json` into `provider_raw`. The files are the export with the provider `api_key` query parameter replaced. The factory never calls that API. Raw collections are not written by the app.

`docker compose up --build` also starts the API. The container points at the compose hostnames, so seed from the host against `127.0.0.1` before or after the app is up. An empty raw database just completes a run with zeros.

Trigger and watch:

```bash
curl -s -X POST localhost:3000/runs -H 'content-type: application/json' -d '{}'
curl -s localhost:3000/runs/<id>
curl -s 'localhost:3000/runs/<id>/errors?page=1&limit=20'
curl -s localhost:3000/health
```

`POST /runs` accepts `{ "collections": ["menus"], "limitPerCollection": 20 }` when you want a smaller pass. Unknown collection names are rejected. A bad environment (wrong URI, `RAW_DB` equal to `DOMAIN_DB`, batch size 0) stops the process before it listens.

## Tests

```bash
npm test
```

Unit tests cover the cases the export actually has: shared location slugs, the double space in `Al  Muntazah`, duplicate listing URLs, `Page limit exceeded.`, `error: false` next to real rows, the placeholder phone, string fees, GeoJSON axis order, a category id reused under two names, an item filed in two sections, and a menu whose `outletCode` does not match the URL.

The integration test runs the worker against `mongodb-memory-server`: paged reads, quarantine, a newer menu processed before an older one, stale items removed, a second run that does not change the domain documents, and a retried job that does not double the counters.

## Decisions worth arguing with

The public restaurant id is `outletCode` / the id in the URL. The `id` field on the menu body matched that id zero times out of 345. It is stored as `vendorId`.

`category_id` is reused inside a menu for sections with different names (60 menus). The category key includes the name. Items are their own collection because 2,266 of them appear in more than one section with the same body.

A bad document is quarantined and the batch continues. A dead database throws, BullMQ retries with exponential backoff, and the last attempt is copied to the `factory-dlq` queue. Those are different outcomes and the code does not mix them.

Writes are conditional upserts. An older snapshot applied later does not win. Counters move in the same update as the checkpoint, and only if this job still owns the cursor, so a retry does not double-count.

`Contact: "00000-00000"` is stored as null. Zero prices are stored as zero.

The provider credential was stripped from the seeded files. Quarantine records and logs do not keep the raw endpoint or the payload.

## Left out

- Auth, a UI, Kubernetes, a live call to xbyte.
- A second provider class. The registry and the field map are the seam. There is one implementation.
- Deleting a service area that a later export no longer mentions. Menu sections are replaced. Areas are only added. A listing page is not a complete set of areas for an outlet.
- Replaying a quarantined document from the API. The raw document is still in `provider_raw`.
- Parsing `25-40 mins` into a numeric window.
- A brand collection. `vendorId` never repeated in this extract.

## With another week

Tombstones for service areas, a replay of quarantine, and a second adapter with a deliberately different file layout so the seam is proven by a diff rather than by a registry map. Metrics on the counters. A brand entity the day `vendorId` actually repeats. Delivery windows, if a consumer needs them as numbers rather than labels.

## Layout

```
src/config            env schema, boot fails closed
src/core              adapter port, write types, batch dedupe
src/providers/xbyte   field map and the five stages
src/persistence       Mongo implementations of the ports
src/queue             dispatcher, worker, dead letter
src/runs              POST /runs, GET /runs/:id, GET /runs/:id/errors
src/health            GET /health
scripts/seed-raw.ts
data/raw              the three exports
```

The pipeline talks to `RawReader`, `DomainStore`, `RunStore`, and `QuarantineStore`. Mongoose is not a dependency. Swapping the driver means new classes behind those ports.
