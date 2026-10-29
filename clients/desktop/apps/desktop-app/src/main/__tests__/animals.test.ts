import { ANIMAL_NAMES, generateUniqueAnimalName } from '../lib/animals';

const animalNames = new Set<string>(ANIMAL_NAMES);
const retiredAnimalNames = ['booby', 'redpanda'];

describe('generateUniqueAnimalName', () => {
  const originalCanopyEnv = process.env.CANOPY_ENV;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalCanopyEnv === undefined) {
      delete process.env.CANOPY_ENV;
    } else {
      process.env.CANOPY_ENV = originalCanopyEnv;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('returns unprefixed animal names in production mode', () => {
    process.env.CANOPY_ENV = 'production';
    delete process.env.NODE_ENV;

    const name = generateUniqueAnimalName(new Set<string>());

    expect(name.startsWith('dev-')).toBe(false);
    expect(animalNames.has(name)).toBe(true);
  });

  it('prefixes animal names in development mode', () => {
    process.env.CANOPY_ENV = 'development';
    delete process.env.NODE_ENV;

    const name = generateUniqueAnimalName(new Set<string>());
    const animalName = name.replace(/^dev-/, '');

    expect(name.startsWith('dev-')).toBe(true);
    expect(animalNames.has(animalName)).toBe(true);
  });

  it('keeps the development prefix on suffixed fallback names', () => {
    process.env.CANOPY_ENV = 'development';
    delete process.env.NODE_ENV;

    const existingNames = new Set<string>();
    for (const animalName of ANIMAL_NAMES) {
      existingNames.add(`dev-${animalName}`);
    }

    const name = generateUniqueAnimalName(existingNames);

    expect(name.startsWith('dev-')).toBe(true);
    expect(name.endsWith('-2')).toBe(true);
  });

  it('keeps the curated animal list unique and free of retired names', () => {
    expect(animalNames.size).toBe(ANIMAL_NAMES.length);

    for (const retiredAnimalName of retiredAnimalNames) {
      expect(ANIMAL_NAMES).not.toContain(retiredAnimalName);
    }
  });
});
