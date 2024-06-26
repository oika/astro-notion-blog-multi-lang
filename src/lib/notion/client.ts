import fs, { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import axios, { AxiosResponse } from 'axios'
import sharp from 'sharp'
import retry from 'async-retry'
import ExifTransformer from 'exif-be-gone'
import {
  NOTION_API_SECRET,
  DATABASE_ID,
  NUMBER_OF_POSTS_PER_PAGE,
  REQUEST_TIMEOUT_MS,
} from '../../server-constants'
import type * as responses from './responses'
import type * as requestParams from './request-params'
import type {
  Database,
  Post,
  Block,
  Paragraph,
  Heading,
  BulletedListItem,
  NumberedListItem,
  ToDo,
  Image,
  Code,
  Quote,
  Equation,
  Callout,
  Embed,
  Video,
  File,
  Bookmark,
  LinkPreview,
  SyncedBlock,
  SyncedFrom,
  Table,
  TableRow,
  TableCell,
  Toggle,
  ColumnList,
  Column,
  TableOfContents,
  RichText,
  Text,
  Annotation,
  SelectProperty,
  Emoji,
  LinkToPage,
  Mention,
  Reference,
  FileOrExternalWithUrl,
  ExternalWithUrl,
  FileOrExternalWithUrlAndExpiryTime,
  TitleMeta,
  SiteMeta,
} from '../interfaces'
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { Client, APIResponseError } from '@notionhq/client'
import AsyncLock from 'async-lock'
import {
  LANGUAGE_KEYS,
  LanguageKey,
  SLUG_META_TITLE,
} from '../../content-constants'

const client = new Client({
  auth: NOTION_API_SECRET,
})

const asyncLock = new AsyncLock({
  timeout: 60000,
  maxOccupationTime: 60000,
  maxPending: 100,
})
const ASYNC_LOCK_POSTS = 'posts'
const ASYNC_LOCK_DB = 'database'

const postsCacheByLang = new Map<
  LanguageKey,
  { posts: Post[]; titleMeta?: TitleMeta }
>()
let dbCache: Database | null = null

const numberOfRetry = 2

async function getTitleMeta(lang: LanguageKey): Promise<TitleMeta | undefined> {
  return await asyncLock.acquire(ASYNC_LOCK_POSTS, () => getTitleMetaCore(lang))
}

async function getTitleMetaCore(
  lang: LanguageKey
): Promise<TitleMeta | undefined> {
  const cache = postsCacheByLang.get(lang)
  if (cache != null) {
    return Promise.resolve(cache.titleMeta)
  }

  const postsAndMeta = await fetchPostsAndMeta(lang)
  postsCacheByLang.set(lang, postsAndMeta)
  return postsAndMeta.titleMeta
}

export async function getAllPostsOfAllLanguages(): Promise<Post[]> {
  return await asyncLock.acquire(
    ASYNC_LOCK_POSTS,
    getAllPostsOfAllLanguagesCore
  )
}

export async function getAllPosts(lang: LanguageKey): Promise<Post[]> {
  return await asyncLock.acquire(ASYNC_LOCK_POSTS, () => getAllPostsCore(lang))
}

async function getAllPostsOfAllLanguagesCore(): Promise<Post[]> {
  const posts: Post[] = []
  for (const lang of LANGUAGE_KEYS) {
    posts.push(...(await getAllPostsCore(lang)))
  }
  return posts
}

async function getAllPostsCore(lang: LanguageKey): Promise<Post[]> {
  const cache = postsCacheByLang.get(lang)
  if (cache != null) {
    return Promise.resolve(cache.posts)
  }

  const postsAndMeta = await fetchPostsAndMeta(lang)
  postsCacheByLang.set(lang, postsAndMeta)
  return postsAndMeta.posts
}

async function fetchPostsAndMeta(lang: LanguageKey) {
  const params: requestParams.QueryDatabase = {
    database_id: DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Published',
          checkbox: {
            equals: true,
          },
        },
        {
          property: 'Date',
          date: {
            on_or_before: new Date().toISOString(),
          },
        },
        {
          property: 'Language',
          multi_select: {
            contains: lang,
          },
        },
      ],
    },
    sorts: [
      {
        property: 'Date',
        direction: 'descending',
      },
    ],
    page_size: 100,
  }

  let results: responses.PageObject[] = []
  while (true) {
    const res = await retry(
      async (bail) => {
        try {
          return (await client.databases.query(
            params
          )) as responses.QueryDatabaseResponse
        } catch (error: unknown) {
          if (error instanceof APIResponseError) {
            if (error.status && error.status >= 400 && error.status < 500) {
              bail(error)
            }
          }
          throw error
        }
      },
      {
        retries: numberOfRetry,
      }
    )

    results = results.concat(res.results)

    if (!res.has_more) {
      break
    }

    params['start_cursor'] = res.next_cursor
  }

  const allPosts = results
    .filter((pageObject) => _validPageObject(pageObject))
    .map((pageObject) => _buildPost(pageObject))
  const posts = allPosts.filter((p) => !p.Meta)
  const titleMeta = allPosts.find((p) => p.Meta && p.Slug === SLUG_META_TITLE)
  return { posts, titleMeta }
}

export async function getPosts(
  lang: LanguageKey,
  pageSize = 10
): Promise<Post[]> {
  const allPosts = await getAllPosts(lang)
  return allPosts.slice(0, pageSize)
}

export async function getRankedPosts(
  lang: LanguageKey,
  pageSize = 10
): Promise<Post[]> {
  const allPosts = await getAllPosts(lang)
  return allPosts
    .filter((post) => !!post.Rank)
    .sort((a, b) => {
      if (a.Rank > b.Rank) {
        return -1
      } else if (a.Rank === b.Rank) {
        return 0
      }
      return 1
    })
    .slice(0, pageSize)
}

export async function getPostBySlug(
  lang: LanguageKey,
  slug: string
): Promise<Post | null> {
  const allPosts = await getAllPosts(lang)
  return allPosts.find((post) => post.Slug === slug) || null
}

export async function getPostByPageId(
  lang: LanguageKey,
  pageId: string
): Promise<Post | null> {
  const allPosts = await getAllPosts(lang)
  return allPosts.find((post) => post.PageId === pageId) || null
}

export async function getPostsByTag(
  lang: LanguageKey,
  tagName: string,
  pageSize = 10
): Promise<Post[]> {
  if (!tagName) return []

  const allPosts = await getAllPosts(lang)
  return allPosts
    .filter((post) => post.Tags.find((tag) => tag.name === tagName))
    .slice(0, pageSize)
}

// page starts from 1 not 0
export async function getPostsByPage(
  lang: LanguageKey,
  page: number
): Promise<Post[]> {
  if (page < 1) {
    return []
  }

  const allPosts = await getAllPosts(lang)

  const startIndex = (page - 1) * NUMBER_OF_POSTS_PER_PAGE
  const endIndex = startIndex + NUMBER_OF_POSTS_PER_PAGE

  return allPosts.slice(startIndex, endIndex)
}

// page starts from 1 not 0
export async function getPostsByTagAndPage(
  lang: LanguageKey,
  tagName: string,
  page: number
): Promise<Post[]> {
  if (page < 1) {
    return []
  }

  const allPosts = await getAllPosts(lang)
  const posts = allPosts.filter((post) =>
    post.Tags.find((tag) => tag.name === tagName)
  )

  const startIndex = (page - 1) * NUMBER_OF_POSTS_PER_PAGE
  const endIndex = startIndex + NUMBER_OF_POSTS_PER_PAGE

  return posts.slice(startIndex, endIndex)
}

export async function getNumberOfPages(lang: LanguageKey): Promise<number> {
  const allPosts = await getAllPosts(lang)
  return (
    Math.floor(allPosts.length / NUMBER_OF_POSTS_PER_PAGE) +
    (allPosts.length % NUMBER_OF_POSTS_PER_PAGE > 0 ? 1 : 0)
  )
}

export async function getNumberOfPagesByTag(
  lang: LanguageKey,
  tagName: string
): Promise<number> {
  const allPosts = await getAllPosts(lang)
  const posts = allPosts.filter((post) =>
    post.Tags.find((tag) => tag.name === tagName)
  )
  return (
    Math.floor(posts.length / NUMBER_OF_POSTS_PER_PAGE) +
    (posts.length % NUMBER_OF_POSTS_PER_PAGE > 0 ? 1 : 0)
  )
}

export async function getAllBlocksByBlockId(blockId: string): Promise<Block[]> {
  let results: responses.BlockObject[] = []

  if (fs.existsSync(`tmp/${blockId}.json`)) {
    results = JSON.parse(fs.readFileSync(`tmp/${blockId}.json`, 'utf-8'))
  } else {
    const params: requestParams.RetrieveBlockChildren = {
      block_id: blockId,
    }

    while (true) {
      const res = await retry(
        async (bail) => {
          try {
            return (await client.blocks.children.list(
              params
            )) as responses.RetrieveBlockChildrenResponse
          } catch (error: unknown) {
            if (error instanceof APIResponseError) {
              if (error.status && error.status >= 400 && error.status < 500) {
                bail(error)
              }
            }
            throw error
          }
        },
        {
          retries: numberOfRetry,
        }
      )

      results = results.concat(res.results)

      if (!res.has_more) {
        break
      }

      params['start_cursor'] = res.next_cursor
    }
  }

  const allBlocks = results.map((blockObject) => _buildBlock(blockObject))

  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i]

    if (block.Type === 'table' && block.Table) {
      block.Table.Rows = await _getTableRows(block.Id)
    } else if (block.Type === 'column_list' && block.ColumnList) {
      block.ColumnList.Columns = await _getColumns(block.Id)
    } else if (
      block.Type === 'bulleted_list_item' &&
      block.BulletedListItem &&
      block.HasChildren
    ) {
      block.BulletedListItem.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'numbered_list_item' &&
      block.NumberedListItem &&
      block.HasChildren
    ) {
      block.NumberedListItem.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'to_do' && block.ToDo && block.HasChildren) {
      block.ToDo.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'synced_block' && block.SyncedBlock) {
      block.SyncedBlock.Children = await _getSyncedBlockChildren(block)
    } else if (block.Type === 'toggle' && block.Toggle) {
      block.Toggle.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'paragraph' &&
      block.Paragraph &&
      block.HasChildren
    ) {
      block.Paragraph.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'heading_1' &&
      block.Heading1 &&
      block.HasChildren
    ) {
      block.Heading1.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'heading_2' &&
      block.Heading2 &&
      block.HasChildren
    ) {
      block.Heading2.Children = await getAllBlocksByBlockId(block.Id)
    } else if (
      block.Type === 'heading_3' &&
      block.Heading3 &&
      block.HasChildren
    ) {
      block.Heading3.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'quote' && block.Quote && block.HasChildren) {
      block.Quote.Children = await getAllBlocksByBlockId(block.Id)
    } else if (block.Type === 'callout' && block.Callout && block.HasChildren) {
      block.Callout.Children = await getAllBlocksByBlockId(block.Id)
    }
  }

  return allBlocks
}

export async function getBlock(blockId: string): Promise<Block> {
  const params: requestParams.RetrieveBlock = {
    block_id: blockId,
  }

  const res = await retry(
    async (bail) => {
      try {
        return (await client.blocks.retrieve(
          params
        )) as responses.RetrieveBlockResponse
      } catch (error: unknown) {
        if (error instanceof APIResponseError) {
          if (error.status && error.status >= 400 && error.status < 500) {
            bail(error)
          }
        }
        throw error
      }
    },
    {
      retries: numberOfRetry,
    }
  )

  return _buildBlock(res)
}

export async function getAllTags(lang: LanguageKey): Promise<SelectProperty[]> {
  const allPosts = await getAllPosts(lang)

  const tagNames: string[] = []
  return allPosts
    .flatMap((post) => post.Tags)
    .reduce((acc, tag) => {
      if (!tagNames.includes(tag.name)) {
        acc.push(tag)
        tagNames.push(tag.name)
      }
      return acc
    }, [] as SelectProperty[])
    .sort((a: SelectProperty, b: SelectProperty) =>
      a.name.localeCompare(b.name)
    )
}

export async function downloadFile(url: URL) {
  let res!: AxiosResponse
  try {
    res = await axios({
      method: 'get',
      url: url.toString(),
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'stream',
    })
  } catch (err) {
    console.log(err)
    return Promise.resolve()
  }

  if (!res || res.status != 200) {
    console.log(res)
    return Promise.resolve()
  }

  const dir = './public/notion/' + url.pathname.split('/').slice(-2)[0]
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }

  const filename = decodeURIComponent(url.pathname.split('/').slice(-1)[0])
  const filepath = `${dir}/${filename}`

  const writeStream = createWriteStream(filepath)
  const rotate = sharp().rotate()

  let stream = res.data

  if (res.headers['content-type'] === 'image/jpeg') {
    stream = stream.pipe(rotate)
  }
  try {
    return pipeline(stream, new ExifTransformer(), writeStream)
  } catch (err) {
    console.log(err)
    writeStream.end()
    return Promise.resolve()
  }
}

export async function getDatabase(): Promise<Pick<Database, 'Icon' | 'Cover'>> {
  return retrieveDatabase()
}

export async function getSiteMeta(lang: LanguageKey): Promise<SiteMeta> {
  const database = await retrieveDatabase()
  const titleMeta = await getTitleMeta(lang)

  return {
    ...database,
    Title: titleMeta?.Title ?? database.Title,
    Description: titleMeta?.Excerpt ?? database.Description,
  }
}

async function retrieveDatabase(): Promise<Database> {
  return asyncLock.acquire(ASYNC_LOCK_DB, retrieveDatabaseCore)
}

async function retrieveDatabaseCore(): Promise<Database> {
  if (dbCache !== null) {
    return Promise.resolve(dbCache)
  }

  const params: requestParams.RetrieveDatabase = {
    database_id: DATABASE_ID,
  }

  const res = await retry(
    async (bail) => {
      try {
        return (await client.databases.retrieve(
          params
        )) as responses.RetrieveDatabaseResponse
      } catch (error: unknown) {
        if (error instanceof APIResponseError) {
          if (error.status && error.status >= 400 && error.status < 500) {
            bail(error)
          }
        }
        throw error
      }
    },
    {
      retries: numberOfRetry,
    }
  )

  let icon: FileOrExternalWithUrl | Emoji | null = null
  if (res.icon) {
    if (res.icon.type === 'emoji' && 'emoji' in res.icon) {
      icon = {
        Type: res.icon.type,
        Emoji: res.icon.emoji,
      }
    } else if (res.icon.type === 'external' && 'external' in res.icon) {
      icon = {
        Type: res.icon.type,
        Url: res.icon.external?.url || '',
      }
    } else if (res.icon.type === 'file' && 'file' in res.icon) {
      icon = {
        Type: res.icon.type,
        Url: res.icon.file?.url || '',
      }
    }
  }

  let cover: FileOrExternalWithUrl | null = null
  if (res.cover) {
    cover = {
      Type: res.cover.type,
      Url:
        (res.cover.type === 'external'
          ? res.cover.external.url
          : res.cover.file.url) || '',
    }
  }

  const database: Database = {
    Title: res.title.map((richText) => richText.plain_text).join(''),
    Description: res.description
      .map((richText) => richText.plain_text)
      .join(''),
    Icon: icon,
    Cover: cover,
  }

  dbCache = database
  return database
}

function _buildBlock(blockObject: responses.BlockObject): Block {
  const block = {
    Id: blockObject.id,
    HasChildren: blockObject.has_children,
  }

  switch (blockObject.type) {
    case 'paragraph':
      const Paragraph: Paragraph = {
        RichTexts: blockObject.paragraph.rich_text.map(_buildRichText),
        Color: blockObject.paragraph.color,
      }
      return {
        ...block,
        Type: 'paragraph',
        Paragraph,
      }
    case 'heading_1':
      const heading1: Heading = {
        RichTexts: blockObject.heading_1.rich_text.map(_buildRichText),
        Color: blockObject.heading_1.color,
        IsToggleable: blockObject.heading_1.is_toggleable,
      }
      return {
        ...block,
        Type: 'heading_1',
        Heading1: heading1,
      }
    case 'heading_2':
      const heading2: Heading = {
        RichTexts: blockObject.heading_2.rich_text.map(_buildRichText),
        Color: blockObject.heading_2.color,
        IsToggleable: blockObject.heading_2.is_toggleable,
      }
      return {
        ...block,
        Type: 'heading_2',
        Heading2: heading2,
      }
    case 'heading_3':
      const heading3: Heading = {
        RichTexts: blockObject.heading_3.rich_text.map(_buildRichText),
        Color: blockObject.heading_3.color,
        IsToggleable: blockObject.heading_3.is_toggleable,
      }
      return {
        ...block,
        Type: 'heading_3',
        Heading3: heading3,
      }
    case 'bulleted_list_item':
      const bulletedListItem: BulletedListItem = {
        RichTexts: blockObject.bulleted_list_item.rich_text.map(_buildRichText),
        Color: blockObject.bulleted_list_item.color,
      }
      return {
        ...block,
        Type: 'bulleted_list_item',
        BulletedListItem: bulletedListItem,
      }
    case 'numbered_list_item':
      const numberedListItem: NumberedListItem = {
        RichTexts: blockObject.numbered_list_item.rich_text.map(_buildRichText),
        Color: blockObject.numbered_list_item.color,
      }
      return {
        ...block,
        Type: 'numbered_list_item',
        NumberedListItem: numberedListItem,
      }
    case 'to_do':
      const toDo: ToDo = {
        RichTexts: blockObject.to_do.rich_text.map(_buildRichText),
        Checked: blockObject.to_do.checked,
        Color: blockObject.to_do.color,
      }
      return {
        ...block,
        Type: 'to_do',
        ToDo: toDo,
      }
    case 'video':
      const video: Video = {
        Caption: blockObject.video.caption?.map(_buildRichText) || [],
        Type: blockObject.video.type,
      }
      if (blockObject.video.type === 'external' && blockObject.video.external) {
        video.External = { Url: blockObject.video.external.url }
      }
      return {
        ...block,
        Type: 'video',
        Video: video,
      }
    case 'image':
      const image: Image = {
        Caption: blockObject.image.caption?.map(_buildRichText) || [],
        Type: blockObject.image.type,
      }
      if (blockObject.image.type === 'external' && blockObject.image.external) {
        image.External = { Url: blockObject.image.external.url }
      } else if (blockObject.image.type === 'file' && blockObject.image.file) {
        image.File = {
          Type: blockObject.image.type,
          Url: blockObject.image.file.url,
          ExpiryTime: blockObject.image.file.expiry_time,
        }
      }
      return {
        ...block,
        Type: 'image',
        Image: image,
      }
    case 'file':
      const file: File = {
        Caption: blockObject.file.caption?.map(_buildRichText) || [],
        Type: blockObject.file.type,
      }
      if (blockObject.file.type === 'external' && blockObject.file.external) {
        file.External = { Url: blockObject.file.external.url }
      } else if (blockObject.file.type === 'file' && blockObject.file.file) {
        file.File = {
          Type: blockObject.file.type,
          Url: blockObject.file.file.url,
          ExpiryTime: blockObject.file.file.expiry_time,
        }
      }
      return {
        ...block,
        Type: 'file',
        File: file,
      }
    case 'code':
      const code: Code = {
        Caption: blockObject.code.caption?.map(_buildRichText) || [],
        RichTexts: blockObject.code.rich_text.map(_buildRichText),
        Language: blockObject.code.language,
      }
      return {
        ...block,
        Type: 'code',
        Code: code,
      }
    case 'quote':
      const quote: Quote = {
        RichTexts: blockObject.quote.rich_text.map(_buildRichText),
        Color: blockObject.quote.color,
      }
      return {
        ...block,
        Type: 'quote',
        Quote: quote,
      }
    case 'equation':
      const equation: Equation = {
        Expression: blockObject.equation.expression,
      }
      return {
        ...block,
        Type: 'equation',
        Equation: equation,
      }
    case 'callout':
      let icon: FileOrExternalWithUrl | Emoji | null = null
      if (blockObject.callout.icon) {
        if (
          blockObject.callout.icon.type === 'emoji' &&
          'emoji' in blockObject.callout.icon
        ) {
          icon = {
            Type: blockObject.callout.icon.type,
            Emoji: blockObject.callout.icon.emoji,
          }
        } else if (
          blockObject.callout.icon.type === 'external' &&
          'external' in blockObject.callout.icon
        ) {
          icon = {
            Type: blockObject.callout.icon.type,
            Url: blockObject.callout.icon.external?.url || '',
          }
        }
      }

      const callout: Callout = {
        RichTexts: blockObject.callout.rich_text.map(_buildRichText),
        Icon: icon,
        Color: blockObject.callout.color,
      }
      return {
        ...block,
        Type: 'callout',
        Callout: callout,
      }
    case 'synced_block':
      let syncedFrom: SyncedFrom | null = null
      if (
        blockObject.synced_block.synced_from &&
        blockObject.synced_block.synced_from.block_id
      ) {
        syncedFrom = {
          BlockId: blockObject.synced_block.synced_from.block_id,
        }
      }

      const syncedBlock: SyncedBlock = {
        SyncedFrom: syncedFrom,
      }
      return {
        ...block,
        Type: 'synced_block',
        SyncedBlock: syncedBlock,
      }
    case 'toggle':
      const toggle: Toggle = {
        RichTexts: blockObject.toggle.rich_text.map(_buildRichText),
        Color: blockObject.toggle.color,
        Children: [],
      }
      return {
        ...block,
        Type: 'toggle',
        Toggle: toggle,
      }
    case 'embed':
      const embed: Embed = {
        Url: blockObject.embed.url,
      }
      return {
        ...block,
        Type: 'embed',
        Embed: embed,
      }
    case 'bookmark':
      const bookmark: Bookmark = {
        Url: blockObject.bookmark.url,
      }
      return {
        ...block,
        Type: 'bookmark',
        Bookmark: bookmark,
      }
    case 'link_preview':
      const linkPreview: LinkPreview = {
        Url: blockObject.link_preview.url,
      }
      return {
        ...block,
        Type: 'link_preview',
        LinkPreview: linkPreview,
      }
    case 'table':
      const table: Table = {
        TableWidth: blockObject.table.table_width,
        HasColumnHeader: blockObject.table.has_column_header,
        HasRowHeader: blockObject.table.has_row_header,
        Rows: [],
      }
      return {
        ...block,
        Type: 'table',
        Table: table,
      }
    case 'column_list':
      const columnList: ColumnList = {
        Columns: [],
      }
      return {
        ...block,
        Type: 'column_list',
        ColumnList: columnList,
      }
    case 'table_of_contents':
      const tableOfContents: TableOfContents = {
        Color: blockObject.table_of_contents.color,
      }
      return {
        ...block,
        Type: 'table_of_contents',
        TableOfContents: tableOfContents,
      }
    case 'link_to_page':
      if (blockObject.link_to_page.page_id) {
        return {
          ...block,
          Type: 'link_to_page',
          LinkToPage: {
            Type: blockObject.link_to_page.type,
            PageId: blockObject.link_to_page.page_id,
          },
        }
      }
      return {
        ...block,
        Type: 'unsupported',
      }
    default:
      return {
        ...block,
        Type: blockObject.type,
      }
  }
}

async function _getTableRows(blockId: string): Promise<TableRow[]> {
  let results: responses.BlockObject[] = []

  if (fs.existsSync(`tmp/${blockId}.json`)) {
    results = JSON.parse(fs.readFileSync(`tmp/${blockId}.json`, 'utf-8'))
  } else {
    const params: requestParams.RetrieveBlockChildren = {
      block_id: blockId,
    }

    while (true) {
      const res = await retry(
        async (bail) => {
          try {
            return (await client.blocks.children.list(
              params
            )) as responses.RetrieveBlockChildrenResponse
          } catch (error: unknown) {
            if (error instanceof APIResponseError) {
              if (error.status && error.status >= 400 && error.status < 500) {
                bail(error)
              }
            }
            throw error
          }
        },
        {
          retries: numberOfRetry,
        }
      )

      results = results.concat(res.results)

      if (!res.has_more) {
        break
      }

      params['start_cursor'] = res.next_cursor
    }
  }

  return results.map((blockObject) => {
    const tableRow: TableRow = {
      Id: blockObject.id,
      Type: blockObject.type,
      HasChildren: blockObject.has_children,
      Cells: [],
    }

    if (blockObject.type === 'table_row' && blockObject.table_row) {
      const cells: TableCell[] = blockObject.table_row.cells.map((cell) => {
        const tableCell: TableCell = {
          RichTexts: cell.map(_buildRichText),
        }

        return tableCell
      })

      tableRow.Cells = cells
    }

    return tableRow
  })
}

async function _getColumns(blockId: string): Promise<Column[]> {
  let results: responses.BlockObject[] = []

  if (fs.existsSync(`tmp/${blockId}.json`)) {
    results = JSON.parse(fs.readFileSync(`tmp/${blockId}.json`, 'utf-8'))
  } else {
    const params: requestParams.RetrieveBlockChildren = {
      block_id: blockId,
    }

    while (true) {
      const res = await retry(
        async (bail) => {
          try {
            return (await client.blocks.children.list(
              params
            )) as responses.RetrieveBlockChildrenResponse
          } catch (error: unknown) {
            if (error instanceof APIResponseError) {
              if (error.status && error.status >= 400 && error.status < 500) {
                bail(error)
              }
            }
            throw error
          }
        },
        {
          retries: numberOfRetry,
        }
      )

      results = results.concat(res.results)

      if (!res.has_more) {
        break
      }

      params['start_cursor'] = res.next_cursor
    }
  }

  return await Promise.all(
    results.map(async (blockObject) => {
      const children = await getAllBlocksByBlockId(blockObject.id)

      const column: Column = {
        Id: blockObject.id,
        Type: blockObject.type,
        HasChildren: blockObject.has_children,
        Children: children,
      }

      return column
    })
  )
}

async function _getSyncedBlockChildren(block: Block): Promise<Block[]> {
  let originalBlock: Block = block
  if (
    'SyncedBlock' in block &&
    block.SyncedBlock.SyncedFrom &&
    block.SyncedBlock.SyncedFrom.BlockId
  ) {
    try {
      originalBlock = await getBlock(block.SyncedBlock.SyncedFrom.BlockId)
    } catch (err) {
      console.log(`Could not retrieve the original synced_block. error: ${err}`)
      return []
    }
  }

  const children = await getAllBlocksByBlockId(originalBlock.Id)
  return children
}

function _validPageObject(pageObject: responses.PageObject): boolean {
  const prop = pageObject.properties
  return (
    !!prop.Page.title &&
    prop.Page.title.length > 0 &&
    !!prop.Slug.rich_text &&
    prop.Slug.rich_text.length > 0 &&
    (!!prop.Date.date || !!prop.Meta)
  )
}

function _buildPost(pageObject: responses.PageObject): Post {
  const prop = pageObject.properties

  let icon: ExternalWithUrl | Emoji | null = null
  if (pageObject.icon) {
    if (pageObject.icon.type === 'emoji' && 'emoji' in pageObject.icon) {
      icon = {
        Type: pageObject.icon.type,
        Emoji: pageObject.icon.emoji,
      }
    } else if (
      pageObject.icon.type === 'external' &&
      'external' in pageObject.icon
    ) {
      icon = {
        Type: pageObject.icon.type,
        Url: pageObject.icon.external.url || '',
      }
    }
  }

  let cover: FileOrExternalWithUrl | null = null
  if (pageObject.cover) {
    cover = {
      Type: pageObject.cover.type,
      Url:
        pageObject.cover.type === 'external'
          ? pageObject.cover.external.url || ''
          : '',
    }
  }

  let featuredImage: FileOrExternalWithUrlAndExpiryTime | null = null
  if (prop.FeaturedImage.files && prop.FeaturedImage.files.length > 0) {
    if (prop.FeaturedImage.files[0].type === 'external') {
      featuredImage = {
        Type: 'external',
        Url: prop.FeaturedImage.files[0].external.url,
      }
    } else if (prop.FeaturedImage.files[0].file) {
      featuredImage = {
        Type: 'file',
        Url: prop.FeaturedImage.files[0].file.url,
        ExpiryTime: prop.FeaturedImage.files[0].file.expiry_time,
      }
    }
  }

  const post: Post = {
    PageId: pageObject.id,
    Title: prop.Page.title
      ? prop.Page.title.map((richText) => richText.plain_text).join('')
      : '',
    Icon: icon,
    Cover: cover,
    Slug: prop.Slug.rich_text
      ? prop.Slug.rich_text.map((richText) => richText.plain_text).join('')
      : '',
    Date: prop.Date.date ? prop.Date.date.start : '',
    Tags: prop.Tags.multi_select ? prop.Tags.multi_select : [],
    Excerpt:
      prop.Excerpt.rich_text && prop.Excerpt.rich_text.length > 0
        ? prop.Excerpt.rich_text.map((richText) => richText.plain_text).join('')
        : '',
    FeaturedImage: featuredImage,
    Rank: prop.Rank.number ? prop.Rank.number : 0,
    Meta: prop.Meta.checkbox === true,
  }

  return post
}

function _buildRichText(richTextObject: responses.RichTextObject): RichText {
  const annotation: Annotation = {
    Bold: richTextObject.annotations.bold,
    Italic: richTextObject.annotations.italic,
    Strikethrough: richTextObject.annotations.strikethrough,
    Underline: richTextObject.annotations.underline,
    Code: richTextObject.annotations.code,
    Color: richTextObject.annotations.color,
  }

  const richText: RichText = {
    Annotation: annotation,
    PlainText: richTextObject.plain_text,
    Href: richTextObject.href,
  }

  if (richTextObject.type === 'text' && richTextObject.text) {
    const text: Text = {
      Content: richTextObject.text.content,
    }

    if (richTextObject.text.link) {
      text.Link = {
        Url: richTextObject.text.link.url,
      }
    }

    richText.Text = text
  } else if (richTextObject.type === 'equation' && richTextObject.equation) {
    const equation: Equation = {
      Expression: richTextObject.equation.expression,
    }
    richText.Equation = equation
  } else if (richTextObject.type === 'mention' && richTextObject.mention) {
    const mention: Mention = {
      Type: richTextObject.mention.type,
    }

    if (richTextObject.mention.type === 'page' && richTextObject.mention.page) {
      const reference: Reference = {
        Id: richTextObject.mention.page.id,
      }
      mention.Page = reference
    }

    richText.Mention = mention
  }

  return richText
}
