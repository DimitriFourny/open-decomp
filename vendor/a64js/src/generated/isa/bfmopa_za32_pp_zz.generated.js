export const ENCODINGS = [
    {
        "instructionId": "bfmopa_za32_pp_zz",
        "encodingId": "bfmopa_za32_pp_zz_",
        "mnemonic": "BFMOPA",
        "className": "SME",
        "fileName": "bfmopa_za32_pp_zz.xml",
        "mask": 4292870172,
        "value": 2172649472,
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
