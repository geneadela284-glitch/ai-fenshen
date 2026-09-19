const RELATION_ALIASES = Object.freeze({
  self: Object.freeze(['我', '自己']),
  mother: Object.freeze(['妈妈', '母亲', '妈']),
  father: Object.freeze(['爸爸', '父亲', '爸']),
  spouse: Object.freeze(['爱人', '伴侣']),
  wife: Object.freeze(['老婆', '妻子', '太太']),
  husband: Object.freeze(['老公', '丈夫']),
  daughter: Object.freeze(['女儿', '闺女']),
  son: Object.freeze(['儿子']),
  child: Object.freeze(['孩子']),
  sibling: Object.freeze(['兄弟姐妹', '兄弟', '姐妹']),
  friend: Object.freeze(['朋友']),
  colleague: Object.freeze(['同事']),
  other: Object.freeze([])
});

export const MemoryRelationToUser = Object.freeze(Object.fromEntries(
  Object.keys(RELATION_ALIASES).map((relation) => [relation.toUpperCase(), relation])
));

const DISPLAY = Object.freeze({
  self: '你', mother: '你妈妈', father: '你爸爸', spouse: '你爱人', wife: '你老婆',
  husband: '你丈夫', daughter: '你女儿', son: '你儿子', child: '你孩子',
  sibling: '你的兄弟姐妹', friend: '你朋友', colleague: '你同事', other: '对方'
});

const PRONOUNS = /(?:^|[，。！？?\s])(?:她|他)(?:的)?(?:什么时候|哪天|是几号)?生日/;
const BIRTHDAY = /(?:生日|诞辰)/;

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function aliasesFor(relation) {
  return [...(RELATION_ALIASES[relation] || [])];
}

function subjectFor(userId, relation) {
  return relation === 'self' ? userId : `family:${relation}`;
}

function exactEntity(ownerUserId, relationToUser, predicate, matchedAlias) {
  const subjectCanonical = subjectFor(ownerUserId, relationToUser);
  return freeze({
    status: 'exact',
    ownerUserId,
    entityType: 'person',
    entityId: subjectCanonical,
    relationToUser,
    subjectCanonical,
    subjectAliases: aliasesFor(relationToUser),
    predicate,
    value: null,
    sourceMemoryIds: [],
    matchedAlias,
    clarificationQuestion: null
  });
}

function ambiguousEntity(ownerUserId, relationToUser, predicate, clarificationQuestion) {
  return freeze({
    status: 'ambiguous',
    ownerUserId,
    entityType: 'person',
    entityId: null,
    relationToUser,
    subjectCanonical: null,
    subjectAliases: aliasesFor(relationToUser),
    predicate,
    value: null,
    sourceMemoryIds: [],
    matchedAlias: null,
    clarificationQuestion
  });
}

function usableConversationEntity(ownerUserId, conversationEntity) {
  return conversationEntity?.status === 'exact' &&
    conversationEntity.ownerUserId === ownerUserId &&
    typeof conversationEntity.subjectCanonical === 'string' &&
    conversationEntity.subjectCanonical.length > 0;
}

export function parseRelationshipEntityQuery({ authenticatedUserId, text, conversationEntity = null } = {}) {
  const ownerUserId = String(authenticatedUserId || '').trim();
  const input = String(text || '').trim();
  if (!ownerUserId || !BIRTHDAY.test(input)) return null;

  if (PRONOUNS.test(input)) {
    if (usableConversationEntity(ownerUserId, conversationEntity)) {
      return exactEntity(ownerUserId, conversationEntity.relationToUser, 'birthday', 'pronoun');
    }
    return ambiguousEntity(ownerUserId, 'other', 'birthday', '你说的“她/他”是指谁？');
  }

  const directSubject = input.startsWith('我的')
    ? input.slice(2)
    : input.startsWith('我')
      ? input.slice(1)
      : input;

  const explicitRelations = Object.entries(RELATION_ALIASES)
    .filter(([relation]) => ['mother', 'father', 'wife', 'husband', 'daughter', 'son'].includes(relation))
    .flatMap(([relation, aliases]) => aliases.map((alias) => ({ relation, alias })))
    .sort((left, right) => right.alias.length - left.alias.length);
  const match = explicitRelations.find(({ alias }) => directSubject.startsWith(alias));
  if (match) {
    const remainder = directSubject.slice(match.alias.length).replace(/^的/, '');
    const nestedRelation = explicitRelations.some(({ alias }) => remainder.startsWith(alias));
    if (nestedRelation) return ambiguousEntity(ownerUserId, 'other', 'birthday', '你问的是哪位家人？');
    return exactEntity(ownerUserId, match.relation, 'birthday', match.alias);
  }

  if (RELATION_ALIASES.spouse.some((alias) => directSubject.startsWith(alias))) {
    if (usableConversationEntity(ownerUserId, conversationEntity) && ['wife', 'husband'].includes(conversationEntity.relationToUser)) {
      return exactEntity(ownerUserId, conversationEntity.relationToUser, 'birthday', 'spouse_context');
    }
    return ambiguousEntity(ownerUserId, 'spouse', 'birthday', '你说的“爱人”是指妻子还是丈夫？');
  }
  if (RELATION_ALIASES.child.some((alias) => directSubject.startsWith(alias))) {
    if (usableConversationEntity(ownerUserId, conversationEntity) && ['daughter', 'son'].includes(conversationEntity.relationToUser)) {
      return exactEntity(ownerUserId, conversationEntity.relationToUser, 'birthday', 'child_context');
    }
    return ambiguousEntity(ownerUserId, 'child', 'birthday', '你说的是哪个孩子？');
  }
  if (/^(?:我|我的|我自己|我自己的).*(?:生日|诞辰)/.test(input)) {
    return exactEntity(ownerUserId, 'self', 'birthday', 'self');
  }
  for (const relation of ['sibling', 'friend', 'colleague']) {
    if (RELATION_ALIASES[relation].some((alias) => directSubject.startsWith(alias))) {
      return ambiguousEntity(ownerUserId, relation, 'birthday', `你说的是哪位${DISPLAY[relation].replace(/^你(?:的)?/, '')}？`);
    }
  }
  if (Object.values(RELATION_ALIASES).flat().some((alias) => alias && input.includes(alias))) {
    return ambiguousEntity(ownerUserId, 'other', 'birthday', '你问的是哪位家人？');
  }
  return null;
}

export function relationshipEntityDisplay(entity) {
  return DISPLAY[entity?.relationToUser] || '对方';
}

export function relationshipNoMatchMessage(entity) {
  return `我目前还不知道${relationshipEntityDisplay(entity)}的生日。你告诉我后，我可以记住。`;
}
