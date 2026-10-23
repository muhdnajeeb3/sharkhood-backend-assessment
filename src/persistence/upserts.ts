import { Document } from 'mongodb';
import { DomainWrite, SourceRank } from '../core/pipeline/types';

/**
 * Upsert that does not care which worker finishes first.
 *
 * A plain `$set` would let an older snapshot overwrite a newer one whenever
 * the older job happened to run later. The pipeline writes incoming fields
 * only when this source is missing or strictly newer (timestamp, then source
 * id). An equal source rewrites the same values, so a retry does not drift.
 *
 * `ingestedAt` stays on the first insert. Wall-clock "updated just now" would
 * change the document on every run of the same input.
 */
export function pipelineFor(write: DomainWrite): Document[] {
  if (write.kind === 'listing') return listingPipeline(write);
  if (write.kind === 'menu-profile') return rankedPipeline(write, 'profileSourceId', 'profileUpdatedAt');
  return rankedPipeline(write, 'sourceId', 'sourceUpdatedAt');
}

function rankWins(sourceIdField: string, updatedAtField: string, rank: SourceRank): Document {
  return {
    $or: [
      { $eq: [{ $ifNull: [`$${sourceIdField}`, null] }, null] },
      { $gt: [rank.updatedAt, `$${updatedAtField}`] },
      {
        $and: [
          { $eq: [rank.updatedAt, `$${updatedAtField}`] },
          { $gte: [rank.sourceId, { $ifNull: [`$${sourceIdField}`, ''] }] },
        ],
      },
    ],
  };
}

function rankedPipeline(write: DomainWrite, sourceIdField: string, updatedAtField: string): Document[] {
  const wins = rankWins(sourceIdField, updatedAtField, write.rank);
  const assigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(write.fields)) {
    assigned[key] = { $cond: ['$_wins', value, { $ifNull: [`$${key}`, null] }] };
  }
  assigned[updatedAtField] = {
    $cond: ['$_wins', write.rank.updatedAt, { $ifNull: [`$${updatedAtField}`, null] }],
  };
  assigned[sourceIdField] = {
    $cond: ['$_wins', write.rank.sourceId, { $ifNull: [`$${sourceIdField}`, null] }],
  };
  if (sourceIdField === 'sourceId') {
    assigned.sourceCollection = {
      $cond: ['$_wins', write.rank.sourceCollection, { $ifNull: ['$sourceCollection', null] }],
    };
  }
  assigned.ingestedAt = { $ifNull: ['$ingestedAt', write.rank.updatedAt] };
  return [{ $set: { _wins: wins } }, { $set: assigned }, { $unset: '_wins' }];
}

/**
 * A listing card must not clobber a menu profile. Listings only own
 * `listingName` / `listingSlug`, and they fill `name` / `slug` when no menu
 * has been applied yet. Menu fields are simply not in this update.
 */
function listingPipeline(write: DomainWrite): Document[] {
  const wins = rankWins('listingSourceId', 'listingUpdatedAt', write.rank);
  const name = write.fields.name;
  const slug = write.fields.slug;
  return [
    { $set: { _wins: wins } },
    {
      $set: {
        publicId: write.fields.publicId,
        channel: write.fields.channel,
        listingName: { $cond: ['$_wins', name, { $ifNull: ['$listingName', null] }] },
        listingSlug: { $cond: ['$_wins', slug, { $ifNull: ['$listingSlug', null] }] },
        listingUpdatedAt: {
          $cond: ['$_wins', write.rank.updatedAt, { $ifNull: ['$listingUpdatedAt', null] }],
        },
        listingSourceId: {
          $cond: ['$_wins', write.rank.sourceId, { $ifNull: ['$listingSourceId', null] }],
        },
        name: {
          $cond: [
            { $and: ['$_wins', { $eq: [{ $ifNull: ['$profileSourceId', null] }, null] }] },
            name,
            { $ifNull: ['$name', null] },
          ],
        },
        slug: {
          $cond: [
            { $and: ['$_wins', { $eq: [{ $ifNull: ['$profileSourceId', null] }, null] }] },
            slug,
            { $ifNull: ['$slug', null] },
          ],
        },
        ingestedAt: { $ifNull: ['$ingestedAt', write.rank.updatedAt] },
      },
    },
    { $unset: '_wins' },
  ];
}
