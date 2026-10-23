import { AnyBulkWriteOperation, Db, Document, Filter } from 'mongodb';
import { DomainStore } from '../core/ports/domain-store';
import { DomainWrite } from '../core/pipeline/types';
import { pipelineFor } from './upserts';

const MENU_CHILDREN = ['menu_categories', 'menu_items', 'menu_placements'] as const;

export class MongoDomainStore extends DomainStore {
  constructor(private readonly db: Db) {
    super();
  }

  async ensureIndexes(): Promise<void> {
    await this.db.collection('locations').createIndex({ slug: 1 });
    await this.db.collection('restaurants').createIndex({ vendorId: 1 });
    await this.db.collection('restaurants').createIndex(
      { coordinates: '2dsphere' },
      { partialFilterExpression: { 'coordinates.type': 'Point' } },
    );
    await this.db.collection('restaurant_service_areas').createIndex({ locationId: 1 });
    await this.db.collection('restaurant_service_areas').createIndex({ restaurantPublicId: 1 });
    await this.db.collection('menu_categories').createIndex({ restaurantPublicId: 1 });
    await this.db.collection('menu_items').createIndex({ restaurantPublicId: 1 });
    await this.db.collection('menu_placements').createIndex({ categoryKey: 1 });
    await this.db.collection('menu_placements').createIndex({ restaurantPublicId: 1 });
  }

  async apply(writes: DomainWrite[]): Promise<void> {
    const listings = writes.filter((write) => write.kind === 'listing');
    const profiles = writes.filter((write) => write.kind === 'menu-profile');
    const rest = writes.filter((write) => write.kind === 'replace');
    // Listing first, then the menu profile, so a batch that contains both
    // (it shouldn't, they come from different collections) still ends on the profile.
    await this.bulk(listings);
    await this.bulk(profiles);
    await this.bulk(rest);
    await this.dropStaleMenuChildren([...new Set(profiles.map((write) => write.id))]);
  }

  /**
   * Categories, items and placements belong to one menu snapshot. After the
   * profile upsert, anything strictly older than the winning snapshot is
   * removed. An older job that runs later re-reads the winning rank and
   * deletes the stale rows it just tried to insert. Service areas are not
   * touched: a listing and a menu are both partial evidence of where an
   * outlet is offered.
   */
  private async dropStaleMenuChildren(publicIds: string[]): Promise<void> {
    for (const publicId of publicIds) {
      const profile = await this.db.collection('restaurants').findOne(
        { _id: publicId } as Document,
        { projection: { profileUpdatedAt: 1, profileSourceId: 1 } },
      );
      const updatedAt = profile?.profileUpdatedAt;
      const sourceId = profile?.profileSourceId;
      if (!(updatedAt instanceof Date) || typeof sourceId !== 'string') continue;
      const stale = {
        restaurantPublicId: publicId,
        $or: [
          { sourceUpdatedAt: { $lt: updatedAt } },
          { sourceUpdatedAt: updatedAt, sourceId: { $lt: sourceId } },
        ],
      };
      for (const name of MENU_CHILDREN) {
        await this.db.collection(name).deleteMany(stale);
      }
    }
  }

  private async bulk(writes: DomainWrite[]): Promise<void> {
    const grouped = new Map<string, DomainWrite[]>();
    for (const write of writes) {
      const list = grouped.get(write.collection) ?? [];
      list.push(write);
      grouped.set(write.collection, list);
    }
    for (const [name, group] of grouped) {
      const ops: AnyBulkWriteOperation<Document>[] = group.map((write) => ({
        updateOne: {
          // Natural keys are strings. The driver's default _id type is ObjectId.
          filter: { _id: write.id } as unknown as Filter<Document>,
          update: pipelineFor(write),
          upsert: true,
        },
      }));
      for (let offset = 0; offset < ops.length; offset += 500) {
        await this.db.collection(name).bulkWrite(ops.slice(offset, offset + 500), { ordered: false });
      }
    }
  }
}
