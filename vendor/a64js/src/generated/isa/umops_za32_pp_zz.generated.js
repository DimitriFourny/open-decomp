export const ENCODINGS = [
    {
        "instructionId": "umops_za32_pp_zz",
        "encodingId": "umops_za32_pp_zz_16",
        "mnemonic": "UMOPS",
        "className": "SME2",
        "fileName": "umops_za32_pp_zz.xml",
        "mask": 4292870172,
        "value": 2709520408,
        "bitCount": 14,
        "fields": [
            {
                "name": "u0",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Pm",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "Pn",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "S",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "ZAda",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-outer-product"
    }
];
