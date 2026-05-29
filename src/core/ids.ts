export type CoreId<Tag extends string> = number & { readonly __coreId: Tag };

export type BindingId = CoreId<"binding">;
export type CtorId = CoreId<"ctor">;
export type TypeNameId = CoreId<"typeName">;
export type RecordId = CoreId<"record">;
export type ModuleId = CoreId<"module">;

export class CoreIdAllocator {
  #nextBinding = 0;
  #nextCtor = 0;
  #nextTypeName = 0;
  #nextRecord = 0;
  #nextModule = 0;

  binding(): BindingId {
    return this.#nextBinding++ as BindingId;
  }

  ctor(): CtorId {
    return this.#nextCtor++ as CtorId;
  }

  typeName(): TypeNameId {
    return this.#nextTypeName++ as TypeNameId;
  }

  record(): RecordId {
    return this.#nextRecord++ as RecordId;
  }

  module(): ModuleId {
    return this.#nextModule++ as ModuleId;
  }
}
