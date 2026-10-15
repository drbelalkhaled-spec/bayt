export const CATEGORIES = [
  "Produce",
  "Dairy & eggs",
  "Meat & fish",
  "Bakery",
  "Pantry",
  "Frozen",
  "Drinks",
  "Snacks",
  "Baby",
  "Cleaning",
  "Personal care",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);

/** Keyword lists, checked in order (more specific categories first). Multi-word and short words match as whole words; long words also match as prefixes. */
const MAP: [Category, string[]][] = [
  ["Baby", ["diaper", "diapers", "nappy", "nappies", "wipes", "baby wipes", "formula", "baby food", "pampers", "baby", "puree", "pacifier", "teether", "cerelac", "baby powder", "baby lotion"]],
  ["Frozen", ["frozen", "ice cream", "ice-cream", "gelato", "popsicle", "fish fingers", "nuggets", "frozen peas", "frozen vegetables", "ice cubes"]],
  ["Cleaning", ["detergent", "dish soap", "dishwashing", "bleach", "cleaner", "cleaning", "sponge", "sponges", "trash bag", "trash bags", "garbage bag", "garbage bags", "bin bags", "laundry", "fabric softener", "softener", "mop", "disinfectant", "dettol", "clorox", "windex", "toilet cleaner", "air freshener", "paper towel", "paper towels", "tissue", "tissues", "toilet paper", "toilet roll", "foil", "cling film", "dishwasher", "washing powder", "washing liquid", "tide", "persil", "fairy", "flash", "harpic"]],
  ["Personal care", ["shampoo", "conditioner", "toothpaste", "toothbrush", "deodorant", "soap", "body wash", "shower gel", "lotion", "moisturizer", "moisturiser", "razor", "razors", "shaving", "sunscreen", "cotton buds", "cotton pads", "tampons", "pads", "sanitary", "mouthwash", "floss", "hand wash", "hand cream", "perfume", "lip balm", "vitamins", "panadol", "paracetamol", "band-aid", "plasters", "hair gel", "nail polish"]],
  ["Meat & fish", ["chicken", "beef", "lamb", "mutton", "meat", "mince", "minced", "steak", "sausage", "sausages", "salami", "turkey", "ham", "bacon", "fish", "salmon", "tuna fish", "shrimp", "prawns", "prawn", "sardines", "sardine", "hamour", "sea bass", "seabass", "calamari", "squid", "crab", "kofta", "shawarma", "ribs", "liver", "fillet", "drumsticks", "wings", "burger patties", "kebab"]],
  ["Dairy & eggs", ["milk", "yogurt", "yoghurt", "laban", "labneh", "labna", "cheese", "halloumi", "feta", "mozzarella", "cheddar", "cream cheese", "akkawi", "nabulsi", "butter", "ghee", "cream", "eggs", "egg", "kashkaval", "creamer", "cheese slices", "kiri", "puck", "laughing cow", "sour cream", "ricotta", "parmesan", "tzatziki", "ayran", "lactose"]],
  ["Bakery", ["bread", "pita", "khubz", "khobz", "toast", "baguette", "croissant", "croissants", "bun", "buns", "rolls", "tortilla", "tortillas", "wraps", "naan", "samoon", "manakish", "cake", "muffin", "muffins", "donut", "donuts", "bagel", "bagels", "ka'ak", "kaak", "tamees", "saj", "markook", "sandwich bread", "pastry", "pastries"]],
  ["Drinks", ["water", "juice", "soda", "cola", "pepsi", "coke", "sprite", "fanta", "7up", "tea", "coffee", "nescafe", "espresso", "lipton", "karak", "energy drink", "red bull", "sparkling", "lemonade", "smoothie", "squash", "cordial", "milkshake", "beer", "wine", "malt", "drink", "drinks", "tang", "vimto", "jallab", "tamarind drink", "barley water", "capsules"]],
  ["Snacks", ["chips", "crisps", "chocolate", "candy", "sweets", "biscuit", "biscuits", "cookies", "cookie", "crackers", "cracker", "popcorn", "pretzels", "nuts", "peanuts", "almonds", "cashews", "pistachio", "pistachios", "walnuts", "hazelnuts", "trail mix", "gum", "lollipop", "gummy", "gummies", "wafer", "wafers", "snack", "snacks", "oreo", "kitkat", "nutella", "granola bar", "cereal bar", "pringles", "doritos", "baklava", "maamoul", "halwa", "halva", "turkish delight", "lokum", "dried fruit", "raisins", "seeds", "sunflower seeds"]],
  ["Produce", ["apple", "apples", "banana", "bananas", "orange", "oranges", "lemon", "lemons", "lime", "limes", "grapes", "strawberry", "strawberries", "blueberries", "berries", "mango", "mangoes", "melon", "watermelon", "peach", "peaches", "pear", "pears", "pomegranate", "figs", "dates", "kiwi", "pineapple", "avocado", "tomato", "tomatoes", "cucumber", "cucumbers", "potato", "potatoes", "sweet potato", "onion", "onions", "garlic", "carrot", "carrots", "lettuce", "salad", "spinach", "cabbage", "cauliflower", "broccoli", "zucchini", "courgette", "eggplant", "aubergine", "pepper", "peppers", "capsicum", "chili", "chilli", "mushroom", "mushrooms", "parsley", "mint", "coriander", "cilantro", "dill", "basil", "rocket", "arugula", "celery", "leek", "radish", "beetroot", "okra", "corn", "pumpkin", "vegetables", "veg", "fruit", "fruits", "herbs", "ginger", "jarjeer", "molokhia", "mulukhiyah", "vine leaves", "grape leaves", "bananas"]],
  ["Pantry", ["rice", "basmati", "bulgur", "burghul", "freekeh", "couscous", "pasta", "spaghetti", "macaroni", "penne", "noodles", "vermicelli", "flour", "sugar", "salt", "oil", "olive oil", "vinegar", "tahini", "hummus", "humus", "falafel mix", "za'atar", "zaatar", "zatar", "sumac", "cardamom", "cinnamon", "cumin", "turmeric", "paprika", "spice", "spices", "baharat", "saffron", "cloves", "nutmeg", "seasoning", "stock cubes", "maggi", "lentils", "lentil", "chickpeas", "beans", "fava", "foul", "ful", "oats", "oatmeal", "cereal", "cornflakes", "muesli", "honey", "jam", "molasses", "dibs", "date syrup", "syrup", "peanut butter", "canned", "tinned", "tuna", "tomato paste", "tomato sauce", "ketchup", "mayo", "mayonnaise", "mustard", "sauce", "pickles", "olives", "baking powder", "baking soda", "yeast", "cornstarch", "breadcrumbs", "rose water", "orange blossom", "ghee jar", "coconut milk", "evaporated milk", "condensed milk", "powdered milk", "milk powder", "pasta sauce", "soy sauce", "tomatoes can", "beans can", "corn can", "dried", "pine nuts", "semolina", "vanilla", "cocoa", "custard", "jelly", "tea bags"]],
];

/** Higher-priority multi-word phrases that must win over their single-word parts. */
const PHRASES: [string, Category][] = [
  ["peanut butter", "Pantry"],
  ["coconut milk", "Pantry"],
  ["evaporated milk", "Pantry"],
  ["condensed milk", "Pantry"],
  ["powdered milk", "Pantry"],
  ["milk powder", "Pantry"],
  ["baby wipes", "Baby"],
  ["baby formula", "Baby"],
  ["baby food", "Baby"],
  ["baby powder", "Baby"],
  ["baby lotion", "Baby"],
  ["baby shampoo", "Baby"],
  ["tuna fish", "Meat & fish"],
  ["canned tuna", "Pantry"],
  ["tomato paste", "Pantry"],
  ["tomato sauce", "Pantry"],
  ["tea bags", "Drinks"],
  ["ice cream", "Frozen"],
  ["ice cubes", "Frozen"],
  ["frozen", "Frozen"],
  ["cream cheese", "Dairy & eggs"],
  ["sour cream", "Dairy & eggs"],
  ["toilet paper", "Cleaning"],
  ["paper towel", "Cleaning"],
  ["dish soap", "Cleaning"],
  ["olive oil", "Pantry"],
  ["sweet potato", "Produce"],
  ["sunflower seeds", "Snacks"],
  ["egg noodles", "Pantry"],
  ["rose water", "Pantry"],
  ["date syrup", "Pantry"],
  ["hand wash", "Personal care"],
  ["body wash", "Personal care"],
  ["water melon", "Produce"],
];

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^a-z0-9'\- ؀-ۿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(words: string[]): RegExp {
  // whole-word match, allowing a trailing plural "s"/"es"
  return new RegExp(`(?:^|[^a-z0-9])(?:${words.map(esc).join("|")})(?:s|es)?(?=$|[^a-z0-9])`);
}

const PHRASE_RES: [RegExp, Category][] = PHRASES.map(([p, c]) => [compile([p]), c]);
const COMPILED: [Category, RegExp][] = MAP.map(([c, words]) => [c, compile(words)]);

/** Best-guess aisle for an item name. Falls back to "Other". */
export function guessCategory(name: string): string {
  const n = norm(name);
  if (!n) return "Other";
  for (const [re, c] of PHRASE_RES) if (re.test(n)) return c;
  for (const [c, re] of COMPILED) if (re.test(n)) return c;
  return "Other";
}
