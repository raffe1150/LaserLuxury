create or replace function public.search_knowledge_chunks(
  p_business_id bigint,
  p_query text,
  p_limit integer default 5
)
returns table (
  source_id uuid,
  business_id bigint,
  chunk_index integer,
  content text,
  metadata jsonb,
  score real
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with raw_tokens as (
    select distinct lower(lexeme) as lexeme
    from pg_catalog.ts_debug('simple', p_query) as debug,
         lateral unnest(debug.lexemes) as lexeme
    where nullif(btrim(lexeme), '') is not null
  ),
  language_scores as (
    select
      count(*) filter (where lexeme = any(array[
        'what','where','when','who','how','the','is','are','do','does','can',
        'your','you','our','we','about','please','tell'
      ]::text[])) as en,
      count(*) filter (where lexeme = any(array[
        'vad','var','när','vem','hur','den','det','är','har','kan','du',
        'din','ditt','dina','er','ert','era','vi','vår','vårt','våra','om'
      ]::text[])) as sv,
      count(*) filter (where lexeme = any(array[
        'was','wo','wann','wer','wie','der','die','das','ist','sind','haben',
        'kann','können','sie','ihr','ihre','über','bitte','mir','uns'
      ]::text[])) as de,
      count(*) filter (where lexeme = any(array[
        'qué','que','dónde','donde','cuándo','cuando','quién','quien','cómo',
        'como','el','la','los','las','es','son','puede','pueden','su','sus',
        'tu','tus','usted','sobre','por','favor','cuál','cual','de'
      ]::text[])) as es,
      count(*) filter (where lexeme = any(array[
        'چیست','چیه','کجاست','کجا','کی','چه','چطور','چگونه','است','هست',
        'هستید','شما','تو','ما','لطفا','لطفاً','درباره','مورد'
      ]::text[])) as fa,
      count(*) filter (where lexeme = any(array[
        'ما','ماذا','أين','اين','متى','من','كيف','هو','هي','هذا','هذه','هل',
        'يمكن','أنت','انت','أنتم','انتم','نحن','عن','فضلك'
      ]::text[])) as ar
    from raw_tokens
  ),
  detected_language as (
    select case
      when greatest(en,sv,de,es,fa,ar) = 0 then null::text
      when ar = greatest(en,sv,de,es,fa,ar) and ar > fa then 'ar'
      when fa = greatest(en,sv,de,es,fa,ar) then 'fa'
      when es = greatest(en,sv,de,es,fa,ar) then 'es'
      when de = greatest(en,sv,de,es,fa,ar) then 'de'
      when sv = greatest(en,sv,de,es,fa,ar) then 'sv'
      else 'en'
    end as lang
    from language_scores
  ),
  significant_tokens as (
    select
      lexeme,
      case
        when char_length(lexeme) >= 7 then left(lexeme, 5)
        else lexeme
      end as root
    from raw_tokens
    where char_length(lexeme) >= 3
      and lexeme <> all (array[
        'what','where','when','who','how','the','this','that','these','those',
        'is','are','was','were','do','does','did','can','could','would','should',
        'your','you','our','we','about','please','tell','information',
        'vad','var','när','vem','hur','den','det','de','är','har','kan','du',
        'din','ditt','dina','er','ert','era','vi','vår','vårt','våra','om',
        'snälla','berätta','mig',
        'was','wo','wann','wer','wie','der','die','das','ist','sind','war',
        'haben','kann','können','sie','ihr','ihre','über','bitte','mir','uns',
        'qué','que','dónde','donde','cuándo','cuando','quién','quien','cómo',
        'como','el','la','los','las','es','son','puede','pueden','su','sus',
        'tu','tus','usted','sobre','por','favor','cuál','cual',
        'چیست','چیه','کجاست','کجا','کی','چه','چطور','چگونه','است','هست',
        'هستید','شما','تو','ما','لطفا','لطفاً','درباره','مورد',
        'ما','ماذا','أين','اين','متى','من','كيف','هو','هي','هذا','هذه','هل',
        'يمكن','أنت','انت','أنتم','انتم','نحن','عن','فضلك'
      ]::text[])
  ),
  query_expression as (
    select
      case
        when count(*) = 0 then null::tsquery
        else to_tsquery(
          'simple'::regconfig,
          string_agg(quote_literal(root) || ':*', ' | ')
        )
      end as query,
      count(*)::real as token_count
    from significant_tokens
  ),
  candidates as (
    select
      kc.source_id,
      kc.business_id,
      kc.chunk_index,
      kc.content,
      kc.metadata,
      kc.search_vector,
      to_tsvector('simple'::regconfig, coalesce(ks.title, '')) as title_vector,
      qe.query,
      qe.token_count,
      dl.lang as detected_lang
    from public.knowledge_chunks kc
    join public.knowledge_sources ks
      on ks.id = kc.source_id
     and ks.business_id = kc.business_id
    cross join query_expression qe
    cross join detected_language dl
    where kc.business_id = p_business_id
      and ks.status = 'ready'
      and nullif(btrim(p_query), '') is not null
      and qe.query is not null
      and (
        kc.search_vector @@ qe.query
        or to_tsvector('simple'::regconfig, coalesce(ks.title, '')) @@ qe.query
      )
  ),
  scored as (
    select
      c.source_id,
      c.business_id,
      c.chunk_index,
      c.content,
      c.metadata,
      (
        (
          select count(*)::real
          from significant_tokens st
          where c.search_vector @@ to_tsquery(
            'simple'::regconfig,
            quote_literal(st.root) || ':*'
          )
        ) / nullif(c.token_count, 0)
        +
        0.35 * (
          (
            select count(*)::real
            from significant_tokens st
            where c.title_vector @@ to_tsquery(
              'simple'::regconfig,
              quote_literal(st.root) || ':*'
            )
          ) / nullif(c.token_count, 0)
        )
        +
        0.10 * ts_rank_cd(c.search_vector, c.query)
        +
        case c.detected_lang
          when 'en' then 0.15 * least(3, (
            select count(*) from pg_catalog.ts_debug('simple', c.content) d,
                 lateral unnest(d.lexemes) x
            where lower(x) = any(array[
              'the','and','may','before','after','customer','customers',
              'appointment','appointments','hours','time'
            ]::text[])
          ))
          when 'sv' then 0.15 * least(3, (
            select count(*) from pg_catalog.ts_debug('simple', c.content) d,
                 lateral unnest(d.lexemes) x
            where lower(x) = any(array[
              'och','kan','kunder','kund','före','efter','tider','tid',
              'bokad','senast','timmar'
            ]::text[])
          ))
          when 'de' then 0.15 * least(3, (
            select count(*) from pg_catalog.ts_debug('simple', c.content) d,
                 lateral unnest(d.lexemes) x
            where lower(x) = any(array[
              'und','können','kunden','kunde','termine','termin','bis',
              'vorher','stunden','zeit'
            ]::text[])
          ))
          when 'es' then 0.15 * least(3, (
            select count(*) from pg_catalog.ts_debug('simple', c.content) d,
                 lateral unnest(d.lexemes) x
            where lower(x) = any(array[
              'los','las','clientes','cliente','pueden','puede','citas','cita',
              'hasta','antes','horas','hora'
            ]::text[])
          ))
          when 'fa' then 0.15 * least(3, (
            select count(*) from pg_catalog.ts_debug('simple', c.content) d,
                 lateral unnest(d.lexemes) x
            where lower(x) = any(array[
              'مشتریان','مشتری','می‌توانند','میتوانند','نوبت','خود','قبل',
              'ساعت','کنند'
            ]::text[])
          ))
          when 'ar' then 0.15 * least(3, (
            select count(*) from pg_catalog.ts_debug('simple', c.content) d,
                 lateral unnest(d.lexemes) x
            where lower(x) = any(array[
              'للعملاء','العملاء','العميل','يمكن','الموعد','موعد','حتى',
              'قبل','ساعة','ساعات'
            ]::text[])
          ))
          else 0
        end
      )::real as score
    from candidates c
  )
  select
    s.source_id,
    s.business_id,
    s.chunk_index,
    s.content,
    s.metadata,
    s.score
  from scored s
  order by s.score desc, s.chunk_index asc
  limit greatest(1, least(coalesce(p_limit, 5), 10));
$$;

revoke all on function public.search_knowledge_chunks(bigint, text, integer)
  from public, anon, authenticated;

grant execute on function public.search_knowledge_chunks(bigint, text, integer)
  to service_role;
