export const ENCODINGS = [
    {
        "instructionId": "bfmopa_za_pp_zz",
        "encodingId": "bfmopa_za_pp_zz_16",
        "mnemonic": "BFMOPA",
        "className": "SME2",
        "fileName": "bfmopa_za_pp_zz.xml",
        "mask": 4292870174,
        "value": 2174746632,
        "bitCount": 15,
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
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME_B16B16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-outer-product"
    }
];
