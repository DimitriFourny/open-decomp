export const ENCODINGS = [
    {
        "instructionId": "fmopa_za16_pp_z8z8",
        "encodingId": "fmopa_za16_pp_z8z8_8",
        "mnemonic": "FMOPA",
        "className": "SME2",
        "fileName": "fmopa_za16_pp_z8z8.xml",
        "mask": 4292870174,
        "value": 2157969416,
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
                "name": "ZAda",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-outer-product"
    }
];
