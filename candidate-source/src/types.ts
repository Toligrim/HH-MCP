export interface Vacancy {
  id: string;
  name: string;
  salary?: { from?: number; to?: number; currency: string; gross: boolean };
  employer: { id: string; name: string; url?: string; alternate_url?: string };
  area: { id: string; name: string };
  snippet?: { requirement?: string; responsibility?: string };
  alternate_url: string;
  published_at: string;
  experience?: { id: string; name: string };
  employment?: { id: string; name: string };
  schedule?: { id: string; name: string };
}

export interface VacancyDetail extends Vacancy {
  description: string;
  key_skills: { name: string }[];
  contacts?: {
    name?: string;
    email?: string;
    phones?: { number: string }[];
  };
}

export interface Employer {
  id: string;
  name: string;
  url: string;
  alternate_url: string;
  open_vacancies: number;
  area?: { id: string; name: string };
  description?: string;
  site_url?: string;
  industries?: { id: string; name: string }[];
}

export interface Resume {
  id: string;
  title: string;
  url: string;
  alternate_url: string;
  area?: { id: string; name: string };
  salary?: { amount: number; currency: string };
  age?: number;
  gender?: { id: string; name: string };
  experience?: {
    company?: string;
    position?: string;
    start: string;
    end?: string;
  }[];
  total_experience?: { months: number };
  education?: {
    level?: { id: string; name: string };
    primary?: { name: string; year: number; organization: string }[];
  };
  skill_set?: string[];
}

export interface Area {
  id: string;
  name: string;
  areas?: Area[];
}

export interface ProfessionalRole {
  id: string;
  name: string;
  roles?: { id: string; name: string }[];
}

export interface SearchResult<T> {
  items: T[];
  found: number;
  pages: number;
  per_page: number;
  page: number;
}

export interface SuggestItem {
  id: string;
  text: string;
}

export interface NamedId {
  id: string;
  name: string;
}

export interface NegotiationSubCollection {
  id: string;
  name: string;
  /** hh.ru may send a parent collection id string, or a boolean `true`. */
  root_collection?: string | boolean;
  counters?: { total?: number; with_updates?: number };
}

export interface NegotiationCollection {
  id: string;
  name: string;
  description?: string;
  url?: string;
  hidden?: boolean;
  short_name?: string;
  order_types?: string[];
  counters?: { total?: number; with_updates?: number };
  sub_collections?: NegotiationSubCollection[];
}

export interface NegotiationsCollectionsResponse {
  collections?: NegotiationCollection[];
  employer_states?: NamedId[];
}

export interface NegotiationItem {
  id: string;
  created_at?: string;
  updated_at?: string;
  has_updates?: boolean;
  state?: NamedId;
  employer_state?: NamedId;
  url?: string;
  messages_url?: string;
  viewed_by_opponent?: boolean;
  source?: string;
  funnel_stage?: {
    id?: string;
    name?: string;
    substate?: { id?: string; name?: string };
  };
  relevant_experience?: {
    total_months?: number;
    vacancy_requirements_match?: boolean;
  };
  counters?: {
    messages?: number;
    unread_messages?: number;
  };
  resume?: {
    id?: string;
    title?: string;
    first_name?: string;
    last_name?: string;
    middle_name?: string;
    age?: number;
    alternate_url?: string;
    area?: NamedId;
    gender?: NamedId;
    salary?: { amount?: number; currency?: string };
    citizenship?: NamedId[];
    total_experience?: { months?: number };
    experience?: {
      company?: string;
      position?: string;
      start?: string;
      end?: string;
    }[];
    education?: {
      level?: NamedId;
      primary?: {
        name?: string;
        organization?: string;
        result?: string;
        year?: number;
      }[];
    };
    skill_set?: string[];
  };
  vacancy?: {
    id?: string;
    name?: string;
  };
}

export interface NegotiationMessage {
  id?: string;
  created_at?: string;
  text?: string;
  author?: { participant_type?: string };
  viewed_by_me?: boolean;
}

export interface NegotiationMessagesResponse {
  items?: NegotiationMessage[];
  found?: number;
  page?: number;
  pages?: number;
  per_page?: number;
}

export interface NegotiationsHistoryItem {
  created_at?: string;
  employer_state?: NamedId;
  vacancy?: { id?: string; name?: string };
}

export interface NegotiationsHistory {
  vacancy?: { id?: string; name?: string };
  negotiations?: NegotiationsHistoryItem[];
  items?: NegotiationsHistoryItem[];
}

export interface ManagerPhone {
  formatted?: string;
  country?: string;
  city?: string;
  number?: string;
  comment?: string | null;
}

export interface EmployerManager {
  id: string;
  full_name?: string;
  email?: string;
  phone?: string | ManagerPhone;
  additional_phone?: string | ManagerPhone;
  manager_type?: NamedId;
  is_main_contact_person?: boolean;
}

export interface VacancyStats {
  views?: { total?: number; previous?: number };
  responses?: { total?: number; previous?: number };
  invitations?: { total?: number; previous?: number };
  [key: string]: unknown;
}

export interface SavedResumeSearch {
  id: string;
  name?: string;
  created_at?: string;
  subscription?: boolean;
  items?: { count?: number };
  new_items?: { count?: number };
}
