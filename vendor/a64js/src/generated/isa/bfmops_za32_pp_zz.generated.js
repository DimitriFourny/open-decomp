export const ENCODINGS = [
    {
        "instructionId": "bfmops_za32_pp_zz",
        "encodingId": "bfmops_za32_pp_zz_",
        "mnemonic": "BFMOPS",
        "className": "SME",
        "fileName": "bfmops_za32_pp_zz.xml",
        "mask": 4292870172,
        "value": 2172649488,
        "bitCount": 14,
        "fields": [
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
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-outer-product"
    }
];
