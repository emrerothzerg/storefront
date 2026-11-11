export { SEARCH_BOX_DEFAULT_LABEL, SEARCH_BOX_PLACEHOLDER, SearchBox } from "./SearchBox";
export type { SearchBoxDepartment, SearchBoxProps } from "./SearchBox";
export {
  MAX_QUERY_LENGTH,
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  SUGGEST_DEBOUNCE_MS,
  buildEmptyStateSuggestions,
  clearRecentSearches,
  getBrowserStorage,
  isSafeSuggestionHref,
  parseRecentSearches,
  parseSuggestBody,
  pushRecentSearch,
  readRecentSearches,
  searchHref,
  shouldFetchSuggestions,
} from "./search-helpers";
export type { RecentStorage, SearchBoxSuggestion, SuggestionKind } from "./search-helpers";
