# Summary-Details Pattern

The summary-details pattern returns a compact representation for collection views and a fuller representation for a single item. A list usually needs enough information to identify and scan each item; a detail view can request larger or less frequently used fields only when the user opens that item.

## The fundamentals

The pattern is useful when detailed records contain large text, nested relationships, computed fields, or data with different access rules. A summary response reduces transfer size and can avoid expensive joins or computation for every row in a list. A detail response provides the additional information needed for one selected record.

Use explicit response shapes (DTOs) rather than returning database entities directly. The summary and detail forms should have clear names and stable contracts. Decide whether the detail response contains the summary fields too; including them is convenient for clients and avoids a second request, while keeping a strict superset makes client code simpler. Apply authorization, pagination, and filtering to both paths. This pattern does not itself guarantee faster queries: select only the needed columns and inspect query behavior.

## Example: TypeScript

```ts
type ArticleSummary = {
  id: string;
  title: string;
  excerpt: string;
  publishedAt: string;
};

type ArticleDetails = ArticleSummary & {
  body: string;
  author: { id: string; name: string };
  relatedArticleIds: string[];
};

interface ArticleRepository {
  listPublished(page: number, pageSize: number): Promise<ArticleSummary[]>;
  findPublishedDetails(id: string): Promise<ArticleDetails | null>;
}

async function getArticles(repository: ArticleRepository, page: number) {
  return repository.listPublished(page, 20);
}

async function getArticle(repository: ArticleRepository, id: string) {
  const article = await repository.findPublishedDetails(id);
  if (!article) throw new Error("Article not found");
  return article;
}
```

The list query can select the title, excerpt, and publication date. The detail query loads the body and related information for one article.

## Example: Python

```python
from dataclasses import asdict, dataclass


@dataclass
class ArticleSummary:
    id: str
    title: str
    excerpt: str
    published_at: str


@dataclass
class ArticleDetails:
    id: str
    title: str
    excerpt: str
    published_at: str
    body: str
    author: dict[str, str]
    related_article_ids: list[str]


def list_articles(repository, page: int) -> list[dict]:
    summaries = repository.list_published(page=page, page_size=20)
    return [asdict(item) for item in summaries]


def get_article(repository, article_id: str) -> dict:
    article = repository.find_published_details(article_id)
    if article is None:
        raise LookupError("Article not found")
    return asdict(article)
```

The repository can map separate database projections into these response types. Serializing an explicit DTO prevents accidental exposure of internal columns.

## Benefits and tradeoffs

This pattern can make list endpoints smaller and reduce unnecessary work. It creates more than one response shape to maintain, and clients may need an additional request when opening a detail page. Caching rules, versioning, and authorization need to remain consistent across both representations. Avoid creating separate shapes when the record is small and the same fields are always needed.

## When to use it

Use summary/details for large or high-volume collections where list and single-item screens have different data needs. Pair summaries with pagination or cursor-based loading for large result sets. Measure response size and query cost to check that the separation delivers a real benefit.
