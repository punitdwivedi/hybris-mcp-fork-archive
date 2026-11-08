import { HybrisClient } from '../dist/hybris-client.js';

const impexContent = `$productCatalog = core_cbusProductCatalog
$catalogVersion = catalogversion(catalog(id[default = $productCatalog]), version[default = 'Staged'])[unique = true, default = $productCatalog:Staged]
$code = code[unique = true]
$seedYear = 2027

INSERT_UPDATE Product; $catalogVersion; $code                 ; seedYear
                     ;                ; 000000000030008923    ; $seedYear
                     ;                ; 000000000030020751    ; $seedYear
                     ;                ; 000000000030074557    ; $seedYear
                     ;                ; 000000000030074558    ; $seedYear
                     ;                ; 000000000030074559    ; $seedYear
                     ;                ; 000000000030074623    ; $seedYear
                     ;                ; 000000000088333829    ; $seedYear
                     ;                ; 000000000088333845    ; $seedYear
                     ;                ; 000000000088372263    ; $seedYear
                     ;                ; 000000000088372271    ; $seedYear
                     ;                ; 000000000089250498    ; $seedYear
                     ;                ; 000000000089250765    ; $seedYear
                     ;                ; 000000000089251036    ; $seedYear
                     ;                ; 000000000089251265    ; $seedYear
                     ;                ; 000000000089252024    ; $seedYear
                     ;                ; 000000000089290856    ; $seedYear
                     ;                ; 000000000089291291    ; $seedYear
                     ;                ; 000000000089291356    ; $seedYear
                     ;                ; 000000000089619823    ; $seedYear
                     ;                ; 000000000091005527    ; $seedYear
                     ;                ; 000000000091005535    ; $seedYear
                     ;                ; 000000000091005543    ; $seedYear
                     ;                ; 000000000091007228    ; $seedYear
                     ;                ; 000000000091043259    ; $seedYear
                     ;                ; 000000000091043291    ; $seedYear
                     ;                ; 000000000091044689    ; $seedYear
                     ;                ; 000000000091044719    ; $seedYear
                     ;                ; 000000000091044743    ; $seedYear
                     ;                ; 000000000091062245    ; $seedYear
                     ;                ; 000000000091231446    ; $seedYear
                     ;                ; 000000000091822088    ; $seedYear
                     ;                ; 000000000091927629    ; $seedYear
                     ;                ; 000000000091927815    ; $seedYear
                     ;                ; 000000000091927912    ; $seedYear
                     ;                ; 000000000091928021    ; $seedYear
                     ;                ; 000000000091928188    ; $seedYear
                     ;                ; 000000000091928501    ; $seedYear
                     ;                ; 000000000091928862    ; $seedYear
                     ;                ; 000000000091928897    ; $seedYear
                     ;                ; 000000000091928900    ; $seedYear
                     ;                ; 000000000091931316    ; $seedYear
`;

const client = new HybrisClient({
  baseUrl: process.env.HYBRIS_BASE_URL,
  username: process.env.HYBRIS_USERNAME,
  password: process.env.HYBRIS_PASSWORD,
  hacPath: process.env.HYBRIS_HAC_PATH !== undefined ? process.env.HYBRIS_HAC_PATH : '/hac',
  occPath: process.env.HYBRIS_OCC_PATH || '/monsantocommercewebservices/v2',
});

console.log('Target:', process.env.HYBRIS_BASE_URL);
console.log('Importing seedYear=2027 for 41 products...');

const result = await client.importImpex(impexContent);
console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
